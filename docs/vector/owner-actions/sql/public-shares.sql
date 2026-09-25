-- Apply once through the owner's Supabase SQL editor after reviewing public-shares.md.
begin;

create table if not exists public.vector_public_shares (
  id text primary key check (id ~ '^[a-f0-9]{32}$'),
  owner_id uuid references auth.users(id) on delete set null,
  secret_hash text not null check (secret_hash ~ '^[a-f0-9]{64}$'),
  snapshot jsonb,
  revision bigint not null default 0 check (revision >= 0),
  expires_at bigint not null,
  updates boolean not null default false,
  consent_version integer not null check (consent_version = 1),
  created_at bigint not null,
  updated_at bigint not null,
  deleted_at bigint,
  check ((deleted_at is null and owner_id is not null and snapshot is not null) or
         (deleted_at is not null and snapshot is null))
);
alter table public.vector_public_shares enable row level security;
revoke all on public.vector_public_shares from public, anon, authenticated;
grant select, insert, update on public.vector_public_shares to service_role;
create index if not exists vector_public_shares_owner on public.vector_public_shares(owner_id);
create index if not exists vector_public_shares_expiry on public.vector_public_shares(expires_at) where deleted_at is null;

-- Account deletion removes content while retaining the unrepeatable share ID.
create or replace function public.vector_public_share_owner_deleted()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.owner_id is null then
    new.snapshot := null;
    new.deleted_at := coalesce(new.deleted_at, floor(extract(epoch from clock_timestamp()) * 1000)::bigint);
    new.updated_at := new.deleted_at;
  end if;
  return new;
end;
$$;
revoke all on function public.vector_public_share_owner_deleted() from public, anon, authenticated;
drop trigger if exists vector_public_share_owner_deleted on public.vector_public_shares;
create trigger vector_public_share_owner_deleted before update of owner_id on public.vector_public_shares
for each row execute function public.vector_public_share_owner_deleted();

-- Only the server's service role may call this RPC. No caller-supplied SQL or paths.
create or replace function public.vector_public_share(request jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  item public.vector_public_shares%rowtype;
  action text := request->>'action';
  share_id text := request->>'id';
  owner uuid;
  secret text := request->>'secret';
  current_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  expiry bigint;
  public_info jsonb;
begin
  if action = 'cleanup' then
    update public.vector_public_shares set snapshot = null, deleted_at = current_ms, updated_at = current_ms
      where id in (select id from public.vector_public_shares where deleted_at is null and expires_at <= current_ms
                   order by expires_at limit 100 for update skip locked);
    return jsonb_build_object('status', 'ok', 'owner', null, 'info', null, 'archive', null);
  end if;
  if share_id is null or share_id !~ '^[a-f0-9]{32}$' or action not in ('read', 'create', 'update', 'delete') then
    return jsonb_build_object('status', 'not_found', 'owner', null, 'info', null, 'archive', null);
  end if;

  if action = 'read' then
    select * into item from public.vector_public_shares where id = share_id;
    if not found or item.deleted_at is not null or item.expires_at <= current_ms or item.owner_id is null then
      return jsonb_build_object('status', 'not_found', 'owner', null, 'info', null, 'archive', null);
    end if;
    public_info := jsonb_build_object('id', item.id, 'url', 'https://vectordev.ai/s/' || item.id,
      'expiresAt', item.expires_at, 'updatedAt', item.updated_at, 'revision', item.revision, 'updates', item.updates);
    return jsonb_build_object('status', 'ok', 'owner', item.owner_id, 'info', public_info, 'archive', item.snapshot);
  end if;

  owner := (request->>'owner')::uuid;
  if owner is null or secret is null or secret !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'not_found', 'owner', null, 'info', null, 'archive', null);
  end if;

  -- Serialize new IDs for one account as well as all operations on an existing ID.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner::text, 731));
  if action = 'create' then
    expiry := (request->>'expiresAt')::bigint;
    if expiry is null or expiry <= current_ms or expiry > current_ms + 2592000000
       or request->>'consentVersion' is distinct from '1'
       or jsonb_typeof(request->'updates') is distinct from 'boolean'
       or jsonb_typeof(request->'archive') is distinct from 'object' then
      return jsonb_build_object('status', 'conflict', 'owner', null, 'info', null, 'archive', null);
    end if;
    if not exists (select 1 from public.vector_public_shares where id = share_id) and
       (select count(*) from public.vector_public_shares where owner_id = owner and deleted_at is null and expires_at > current_ms) >= 20 then
      return jsonb_build_object('status', 'limit', 'owner', null, 'info', null, 'archive', null);
    end if;
    insert into public.vector_public_shares(id, owner_id, secret_hash, snapshot, expires_at, updates, consent_version, created_at, updated_at)
      values (share_id, owner, secret, request->'archive', expiry, (request->>'updates')::boolean, 1, current_ms, current_ms)
      on conflict (id) do nothing;
  end if;

  if action = 'delete' then
    -- A lost create response may be followed by deletion before create reaches us.
    -- Insert the tombstone first so a delayed POST can never recreate the link.
    insert into public.vector_public_shares(id, owner_id, secret_hash, snapshot, expires_at, consent_version, created_at, updated_at, deleted_at)
      values (share_id, owner, secret, null, current_ms, 1, current_ms, current_ms, current_ms)
      on conflict (id) do nothing;
  end if;

  select * into item from public.vector_public_shares where id = share_id for update;
  if not found or item.owner_id is distinct from owner or item.secret_hash <> secret then
    return jsonb_build_object('status', 'not_found', 'owner', null, 'info', null, 'archive', null);
  end if;
  if action = 'delete' then
    update public.vector_public_shares set snapshot = null, deleted_at = coalesce(deleted_at, current_ms), updated_at = current_ms where id = share_id;
    return jsonb_build_object('status', 'ok', 'owner', null, 'info', null, 'archive', null);
  end if;
  if item.deleted_at is not null or item.expires_at <= current_ms then
    return jsonb_build_object('status', 'conflict', 'owner', null, 'info', null, 'archive', null);
  end if;

  if action = 'update' and item.snapshot is distinct from request->'archive' then
    if not item.updates or item.revision is distinct from (request->>'revision')::bigint
       or jsonb_typeof(request->'archive') is distinct from 'object' then
      return jsonb_build_object('status', 'conflict', 'owner', null, 'info', null, 'archive', null);
    end if;
    update public.vector_public_shares set snapshot = request->'archive', revision = revision + 1, updated_at = current_ms
      where id = share_id returning * into item;
  end if;
  public_info := jsonb_build_object('id', item.id, 'url', 'https://vectordev.ai/s/' || item.id,
    'expiresAt', item.expires_at, 'updatedAt', item.updated_at, 'revision', item.revision, 'updates', item.updates);
  return jsonb_build_object('status', 'ok', 'owner', item.owner_id, 'info', public_info, 'archive', null);
end;
$$;
revoke all on function public.vector_public_share(jsonb) from public, anon, authenticated;
grant execute on function public.vector_public_share(jsonb) to service_role;

commit;
