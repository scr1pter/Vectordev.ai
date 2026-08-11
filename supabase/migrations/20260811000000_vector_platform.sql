create extension if not exists pgcrypto;

create table if not exists public.vector_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vector_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  stripe_subscription_id text not null unique,
  plan text not null check (plan in ('monthly', 'annual')),
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  payment_failed_at timestamptz,
  grace_ends_at timestamptz,
  installer_downloaded_at timestamptz,
  installer_download_target text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vector_licenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  stripe_customer_id text not null,
  key_last_four text not null,
  device_hash text,
  device_name text,
  activated_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.vector_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  secret_hash text not null unique,
  secret_prefix text not null,
  last_four text not null,
  scopes text[] not null default array['agents:read', 'agents:write', 'api:execute'],
  daily_unit_limit integer not null default 500 check (daily_unit_limit between 1 and 100000),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.vector_stripe_events (
  id text primary key,
  type text not null,
  event_created timestamptz not null,
  status text not null default 'processing' check (status in ('processing', 'complete', 'failed')),
  attempts integer not null default 1,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vector_agent_teams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  objective text not null check (char_length(objective) between 1 and 12000),
  mode text not null default 'coordinated' check (mode in ('coordinated', 'isolated')),
  status text not null default 'active' check (status in ('active', 'integrating', 'review', 'complete', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vector_agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid references public.vector_agent_teams(id) on delete set null,
  role text not null default 'worker' check (role in ('worker', 'integrator')),
  name text not null check (char_length(name) between 1 and 100),
  prompt text not null check (char_length(prompt) between 1 and 50000),
  repository_url text,
  repository_branch text,
  workspace_dir text,
  provider text,
  model text not null,
  status text not null default 'queued' check (status in ('queued', 'starting', 'running', 'needs_input', 'complete', 'failed', 'canceled')),
  current_step text,
  sandbox_name text,
  command_id text,
  selected_tools jsonb not null default '[]'::jsonb,
  summary text,
  logs text,
  diff text,
  diff_stats jsonb,
  error text,
  token_usage jsonb,
  cost_usd numeric(12, 6),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vector_agent_messages (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.vector_agent_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.vector_tool_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plugin_id text,
  name text not null check (char_length(name) between 1 and 100),
  kind text not null check (kind in ('plugin', 'mcp_remote', 'mcp_local')),
  encrypted_config text not null,
  enabled boolean not null default true,
  last_status text not null default 'configured',
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.vector_api_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  description text,
  requests jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vector_api_environments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  encrypted_values text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.vector_api_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  method text not null,
  url text not null,
  status integer,
  duration_ms integer,
  response_bytes integer,
  request_summary jsonb not null default '{}'::jsonb,
  response_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.vector_usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (char_length(kind) between 1 and 80),
  units integer not null default 1 check (units > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists vector_agent_runs_user_created_idx on public.vector_agent_runs(user_id, created_at desc);
create index if not exists vector_agent_runs_team_idx on public.vector_agent_runs(team_id, created_at);
create unique index if not exists vector_agent_runs_integrator_idx
  on public.vector_agent_runs(team_id)
  where team_id is not null and role = 'integrator';
create index if not exists vector_agent_messages_run_idx on public.vector_agent_messages(run_id, created_at);
create index if not exists vector_api_history_user_created_idx on public.vector_api_history(user_id, created_at desc);
create index if not exists vector_tool_connections_user_idx on public.vector_tool_connections(user_id, enabled);
create index if not exists vector_usage_events_window_idx on public.vector_usage_events(user_id, kind, created_at desc);

create or replace function public.vector_consume_quota(
  p_user_id uuid,
  p_kind text,
  p_units integer,
  p_limit integer,
  p_window_seconds integer,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  used_units bigint;
begin
  if p_units <= 0 or p_limit <= 0 or p_window_seconds <= 0 then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text || ':' || p_kind));
  select coalesce(sum(units), 0)
    into used_units
    from public.vector_usage_events
   where user_id = p_user_id
     and kind = p_kind
     and created_at >= now() - make_interval(secs => p_window_seconds);
  if used_units + p_units > p_limit then
    return false;
  end if;
  insert into public.vector_usage_events (user_id, kind, units, metadata)
  values (p_user_id, p_kind, p_units, coalesce(p_metadata, '{}'::jsonb));
  return true;
end;
$$;

create or replace function public.vector_claim_stripe_event(
  p_event_id text,
  p_event_type text,
  p_event_created timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean := false;
begin
  insert into public.vector_stripe_events (id, type, event_created)
  values (p_event_id, p_event_type, p_event_created)
  on conflict (id) do nothing;
  if found then
    return true;
  end if;

  update public.vector_stripe_events
     set status = 'processing',
         attempts = attempts + 1,
         last_error = null,
         updated_at = now()
   where id = p_event_id
     and status <> 'complete'
     and (status = 'failed' or updated_at < now() - interval '5 minutes')
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create or replace function public.vector_claim_device(
  p_user_id uuid,
  p_device_hash text,
  p_device_name text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext('vector-device:' || p_user_id::text));
  update public.vector_licenses
     set device_hash = p_device_hash,
         device_name = p_device_name,
         activated_at = now(),
         deactivated_at = null
   where user_id = p_user_id
     and (device_hash is null or device_hash = p_device_hash)
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create or replace function public.vector_release_device(
  p_user_id uuid,
  p_device_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  released boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext('vector-device:' || p_user_id::text));
  update public.vector_licenses
     set device_hash = null,
         device_name = null,
         deactivated_at = now()
   where user_id = p_user_id
     and device_hash = p_device_hash
  returning true into released;
  return coalesce(released, false);
end;
$$;

create or replace function public.vector_claim_installer_download(
  p_user_id uuid,
  p_target text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.vector_subscriptions
     set installer_downloaded_at = now(),
         installer_download_target = p_target,
         updated_at = now()
   where user_id = p_user_id
     and installer_downloaded_at is null;
  return found;
end;
$$;

create or replace function public.vector_enforce_agent_ownership()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'vector_agent_runs' and new.team_id is not null then
    if not exists (
      select 1 from public.vector_agent_teams
       where id = new.team_id and user_id = new.user_id
    ) then
      raise exception 'Agent team ownership mismatch';
    end if;
  elsif tg_table_name = 'vector_agent_messages' then
    if not exists (
      select 1 from public.vector_agent_runs
       where id = new.run_id and user_id = new.user_id
    ) then
      raise exception 'Agent run ownership mismatch';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.vector_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.vector_create_profile()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.vector_profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update set email = excluded.email, updated_at = now();
  return new;
end;
$$;

drop trigger if exists vector_auth_user_created on auth.users;
create trigger vector_auth_user_created
after insert or update of email on auth.users
for each row execute function public.vector_create_profile();

drop trigger if exists vector_profiles_touch on public.vector_profiles;
create trigger vector_profiles_touch before update on public.vector_profiles
for each row execute function public.vector_touch_updated_at();
drop trigger if exists vector_subscriptions_touch on public.vector_subscriptions;
create trigger vector_subscriptions_touch before update on public.vector_subscriptions
for each row execute function public.vector_touch_updated_at();
drop trigger if exists vector_agent_teams_touch on public.vector_agent_teams;
create trigger vector_agent_teams_touch before update on public.vector_agent_teams
for each row execute function public.vector_touch_updated_at();
drop trigger if exists vector_agent_runs_touch on public.vector_agent_runs;
create trigger vector_agent_runs_touch before update on public.vector_agent_runs
for each row execute function public.vector_touch_updated_at();
drop trigger if exists vector_tool_connections_touch on public.vector_tool_connections;
create trigger vector_tool_connections_touch before update on public.vector_tool_connections
for each row execute function public.vector_touch_updated_at();
drop trigger if exists vector_stripe_events_touch on public.vector_stripe_events;
create trigger vector_stripe_events_touch before update on public.vector_stripe_events
for each row execute function public.vector_touch_updated_at();
drop trigger if exists vector_agent_runs_owner on public.vector_agent_runs;
create trigger vector_agent_runs_owner before insert or update of team_id, user_id on public.vector_agent_runs
for each row execute function public.vector_enforce_agent_ownership();
drop trigger if exists vector_agent_messages_owner on public.vector_agent_messages;
create trigger vector_agent_messages_owner before insert or update of run_id, user_id on public.vector_agent_messages
for each row execute function public.vector_enforce_agent_ownership();
drop trigger if exists vector_api_collections_touch on public.vector_api_collections;
create trigger vector_api_collections_touch before update on public.vector_api_collections
for each row execute function public.vector_touch_updated_at();
drop trigger if exists vector_api_environments_touch on public.vector_api_environments;
create trigger vector_api_environments_touch before update on public.vector_api_environments
for each row execute function public.vector_touch_updated_at();

alter table public.vector_profiles enable row level security;
alter table public.vector_subscriptions enable row level security;
alter table public.vector_licenses enable row level security;
alter table public.vector_api_keys enable row level security;
alter table public.vector_stripe_events enable row level security;
alter table public.vector_agent_teams enable row level security;
alter table public.vector_agent_runs enable row level security;
alter table public.vector_agent_messages enable row level security;
alter table public.vector_tool_connections enable row level security;
alter table public.vector_api_collections enable row level security;
alter table public.vector_api_environments enable row level security;
alter table public.vector_api_history enable row level security;
alter table public.vector_usage_events enable row level security;

drop policy if exists "profiles are readable by owner" on public.vector_profiles;
create policy "profiles are readable by owner" on public.vector_profiles for select using (auth.uid() = id);
drop policy if exists "profiles are editable by owner" on public.vector_profiles;
create policy "profiles are editable by owner" on public.vector_profiles for update using (auth.uid() = id);

-- Product data is intentionally server-only. The service-role client validates
-- ownership on every API request; authenticated browser clients cannot query
-- secret hashes, encrypted MCP credentials, agent logs, or billing records.
revoke all on public.vector_subscriptions from anon, authenticated;
revoke all on public.vector_licenses from anon, authenticated;
revoke all on public.vector_api_keys from anon, authenticated;
revoke all on public.vector_stripe_events from anon, authenticated;
revoke all on public.vector_agent_teams from anon, authenticated;
revoke all on public.vector_agent_runs from anon, authenticated;
revoke all on public.vector_agent_messages from anon, authenticated;
revoke all on public.vector_tool_connections from anon, authenticated;
revoke all on public.vector_api_collections from anon, authenticated;
revoke all on public.vector_api_environments from anon, authenticated;
revoke all on public.vector_api_history from anon, authenticated;
revoke all on public.vector_usage_events from anon, authenticated;
revoke execute on function public.vector_consume_quota(uuid, text, integer, integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.vector_consume_quota(uuid, text, integer, integer, integer, jsonb) to service_role;
revoke execute on function public.vector_claim_stripe_event(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.vector_claim_stripe_event(text, text, timestamptz) to service_role;
revoke execute on function public.vector_claim_device(uuid, text, text) from public, anon, authenticated;
grant execute on function public.vector_claim_device(uuid, text, text) to service_role;
revoke execute on function public.vector_release_device(uuid, text) from public, anon, authenticated;
grant execute on function public.vector_release_device(uuid, text) to service_role;
revoke execute on function public.vector_claim_installer_download(uuid, text) from public, anon, authenticated;
grant execute on function public.vector_claim_installer_download(uuid, text) to service_role;

grant select, update on public.vector_profiles to authenticated;
