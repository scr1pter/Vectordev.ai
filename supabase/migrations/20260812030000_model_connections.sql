create table if not exists public.vector_model_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_id text not null check (char_length(provider_id) between 1 and 80),
  name text not null check (char_length(name) between 1 and 100),
  models jsonb not null default '[]'::jsonb,
  encrypted_config text not null,
  enabled boolean not null default true,
  last_status text not null default 'configured',
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider_id)
);

create index if not exists vector_model_connections_user_idx
  on public.vector_model_connections(user_id, enabled);

drop trigger if exists vector_model_connections_touch on public.vector_model_connections;
create trigger vector_model_connections_touch before update on public.vector_model_connections
for each row execute function public.vector_touch_updated_at();

alter table public.vector_model_connections enable row level security;
revoke all on public.vector_model_connections from anon, authenticated;
