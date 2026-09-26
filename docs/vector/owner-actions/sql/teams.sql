-- Owner-reviewed provisioning only. Clients receive signed read-only snapshots through the API.
begin;

create or replace function public.vector_team_config_valid(value jsonb)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare valid boolean;
begin
  if jsonb_typeof(value) is distinct from 'object' or octet_length(value::text) > 160000 then return false; end if;
  with recursive nodes(item, depth) as (
    select value, 0
    union all
    select child.item, nodes.depth + 1 from nodes cross join lateral (
      select entry.value as item from pg_catalog.jsonb_each(case when jsonb_typeof(nodes.item) = 'object' then nodes.item else '{}'::jsonb end) entry
      union all
      select entry.value as item from pg_catalog.jsonb_array_elements(case when jsonb_typeof(nodes.item) = 'array' then nodes.item else '[]'::jsonb end) entry
    ) child where nodes.depth <= 32
  )
  select coalesce(bool_and(depth <= 32 and not (jsonb_typeof(item) = 'object' and item ?| array['__proto__', 'constructor', 'prototype'])), true)
    into valid from nodes;
  return valid;
end;
$$;
revoke all on function public.vector_team_config_valid(jsonb) from public, anon, authenticated;
grant execute on function public.vector_team_config_valid(jsonb) to service_role;

create table if not exists public.vector_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120 and name !~ '[[:cntrl:]]'),
  created_at bigint not null default floor(extract(epoch from clock_timestamp()) * 1000)::bigint
);
create table if not exists public.vector_team_memberships (
  team_id uuid not null references public.vector_teams(id) on delete cascade,
  account_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at bigint not null default floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
  primary key (team_id, account_id)
);
create index if not exists vector_team_memberships_account on public.vector_team_memberships(account_id);
create table if not exists public.vector_team_configurations (
  team_id uuid primary key references public.vector_teams(id) on delete cascade,
  config jsonb not null default '{}'::jsonb check (public.vector_team_config_valid(config)),
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  updated_at bigint not null default floor(extract(epoch from clock_timestamp()) * 1000)::bigint
);
alter table public.vector_teams enable row level security;
alter table public.vector_team_memberships enable row level security;
alter table public.vector_team_configurations enable row level security;
revoke all on public.vector_teams, public.vector_team_memberships, public.vector_team_configurations from public, anon, authenticated;
grant select, insert, update, delete on public.vector_teams, public.vector_team_memberships, public.vector_team_configurations to service_role;

create or replace function public.vector_team_configuration_revision()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
  else
    if new.team_id is distinct from old.team_id then raise exception 'Team configuration identity cannot change'; end if;
    new.revision := old.revision + 1;
  end if;
  new.updated_at := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  return new;
end;
$$;
revoke all on function public.vector_team_configuration_revision() from public, anon, authenticated;
drop trigger if exists vector_team_configuration_revision on public.vector_team_configurations;
create trigger vector_team_configuration_revision before insert or update on public.vector_team_configurations
for each row execute function public.vector_team_configuration_revision();

-- One SQL snapshot binds the live account, membership roster and selected configuration.
-- SECURITY DEFINER permits the restricted RPC to check auth.users without exposing that table.
create or replace function public.vector_team_configuration(request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare account uuid; selected uuid; result jsonb;
begin
  if jsonb_typeof(request) is distinct from 'object'
     or jsonb_typeof(request->'accountID') is distinct from 'string'
     or exists (select 1 from pg_catalog.jsonb_object_keys(request) item where item not in ('accountID', 'orgID'))
     or (request ? 'orgID' and jsonb_typeof(request->'orgID') is distinct from 'string') then
    return jsonb_build_object('status', 'invalid', 'orgs', '[]'::jsonb, 'active', null);
  end if;
  begin
    account := (request->>'accountID')::uuid;
    selected := (request->>'orgID')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('status', 'invalid', 'orgs', '[]'::jsonb, 'active', null);
  end;
  with viewer as materialized (select id from auth.users where id = account),
  memberships as materialized (
    select team.id, team.name, member.role from public.vector_team_memberships member
    join public.vector_teams team on team.id = member.team_id
    where member.account_id = account and exists (select 1 from viewer)
    order by team.id limit 101
  ),
  policy as materialized (
    select configuration.team_id as id, configuration.revision, configuration.config
    from public.vector_team_configurations configuration
    join memberships member on member.id = configuration.team_id where configuration.team_id = selected
  )
  select jsonb_build_object(
    'status', case
      when not exists (select 1 from viewer) then 'account_missing'
      when (select count(*) from memberships) > 100 then 'limit'
      when selected is not null and not exists (select 1 from memberships where id = selected) then 'denied'
      when selected is not null and not exists (select 1 from policy) then 'unavailable'
      else 'ok' end,
    'orgs', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'role', role) order by id) from memberships), '[]'::jsonb),
    'active', (select jsonb_build_object('id', id, 'revision', revision, 'config', config) from policy)
  ) into result;
  return result;
end;
$$;
revoke all on function public.vector_team_configuration(jsonb) from public, anon, authenticated;
grant execute on function public.vector_team_configuration(jsonb) to service_role;

commit;
