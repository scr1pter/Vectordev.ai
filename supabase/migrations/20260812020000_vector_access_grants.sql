create table if not exists public.vector_access_grants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  label text not null default 'internal',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists vector_access_grants_touch on public.vector_access_grants;
create trigger vector_access_grants_touch before update on public.vector_access_grants
for each row execute function public.vector_touch_updated_at();

alter table public.vector_access_grants enable row level security;
revoke all on public.vector_access_grants from anon, authenticated;
