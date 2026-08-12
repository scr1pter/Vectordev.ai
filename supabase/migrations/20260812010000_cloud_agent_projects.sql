create table if not exists public.vector_agent_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  description text not null default '' check (char_length(description) <= 2000),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vector_agent_teams
  add column if not exists project_id uuid references public.vector_agent_projects(id) on delete set null;

with owners as (
  select distinct user_id
    from public.vector_agent_teams
   where project_id is null
), created as (
  insert into public.vector_agent_projects (user_id, name, description)
  select user_id, 'Previous work', 'Cloud tasks created before projects were introduced.'
    from owners
  returning id, user_id
)
update public.vector_agent_teams as task
   set project_id = created.id
  from created
 where task.user_id = created.user_id
   and task.project_id is null;

create index if not exists vector_agent_projects_user_updated_idx
  on public.vector_agent_projects(user_id, updated_at desc);
create index if not exists vector_agent_teams_project_idx
  on public.vector_agent_teams(project_id, updated_at desc);

drop index if exists public.vector_agent_runs_integrator_idx;
create index if not exists vector_agent_runs_integrator_idx
  on public.vector_agent_runs(team_id, created_at desc)
  where team_id is not null and role = 'integrator';

drop trigger if exists vector_agent_projects_touch on public.vector_agent_projects;
create trigger vector_agent_projects_touch before update on public.vector_agent_projects
for each row execute function public.vector_touch_updated_at();

create or replace function public.vector_enforce_agent_ownership()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  row_data jsonb := to_jsonb(new);
begin
  if tg_table_name = 'vector_agent_teams' and nullif(row_data ->> 'project_id', '') is not null then
    if not exists (
      select 1
        from public.vector_agent_projects
       where id = (row_data ->> 'project_id')::uuid
         and user_id = (row_data ->> 'user_id')::uuid
    ) then
      raise exception 'Agent project ownership mismatch';
    end if;
  elsif tg_table_name = 'vector_agent_runs' and nullif(row_data ->> 'team_id', '') is not null then
    if not exists (
      select 1
        from public.vector_agent_teams
       where id = (row_data ->> 'team_id')::uuid
         and user_id = (row_data ->> 'user_id')::uuid
    ) then
      raise exception 'Agent task ownership mismatch';
    end if;
  elsif tg_table_name = 'vector_agent_messages' then
    if not exists (
      select 1
        from public.vector_agent_runs
       where id = (row_data ->> 'run_id')::uuid
         and user_id = (row_data ->> 'user_id')::uuid
    ) then
      raise exception 'Agent run ownership mismatch';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists vector_agent_teams_owner on public.vector_agent_teams;
create trigger vector_agent_teams_owner before insert or update of project_id, user_id on public.vector_agent_teams
for each row execute function public.vector_enforce_agent_ownership();

alter table public.vector_agent_projects enable row level security;
revoke all on public.vector_agent_projects from anon, authenticated;
