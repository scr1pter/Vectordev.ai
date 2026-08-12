create table if not exists public.vector_companion_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.vector_tool_connections(id) on delete set null,
  name text not null check (char_length(name) between 1 and 100),
  platform text not null check (char_length(platform) between 1 and 80),
  secret_hash text not null,
  permissions jsonb not null default '["browser"]'::jsonb,
  status text not null default 'connected' check (status in ('connected', 'revoked')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vector_companion_pairings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  secret_hash text not null,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.vector_companion_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.vector_companion_devices(id) on delete cascade,
  run_id uuid references public.vector_agent_runs(id) on delete set null,
  action text not null check (action in ('browser', 'shell')),
  payload jsonb not null default '{}'::jsonb,
  risk text not null default 'medium' check (risk in ('low', 'medium', 'high')),
  status text not null default 'queued' check (status in ('queued', 'awaiting_approval', 'running', 'success', 'failed', 'denied', 'canceled')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists vector_companion_devices_user_idx
  on public.vector_companion_devices(user_id, status);
create index if not exists vector_companion_commands_device_idx
  on public.vector_companion_commands(device_id, status, created_at);

drop trigger if exists vector_companion_devices_touch on public.vector_companion_devices;
create trigger vector_companion_devices_touch before update on public.vector_companion_devices
for each row execute function public.vector_touch_updated_at();
drop trigger if exists vector_companion_commands_touch on public.vector_companion_commands;
create trigger vector_companion_commands_touch before update on public.vector_companion_commands
for each row execute function public.vector_touch_updated_at();

alter table public.vector_companion_devices enable row level security;
alter table public.vector_companion_pairings enable row level security;
alter table public.vector_companion_commands enable row level security;
revoke all on public.vector_companion_devices from anon, authenticated;
revoke all on public.vector_companion_pairings from anon, authenticated;
revoke all on public.vector_companion_commands from anon, authenticated;
