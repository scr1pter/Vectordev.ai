-- Apply once through the owner's Supabase SQL editor after reviewing usage.md. Safe to re-run.
-- Counts only: a random install ID or the account ID, app version, OS, CPU architecture and
-- per-day session counts. Never prompts, code, file names, model output, IP addresses or user agents.
begin;

create table if not exists public.vector_usage_daily (
  key text not null check (key ~ '^(install|account):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  client text not null check (client in ('desktop', 'cli')),
  day date not null,
  account_id uuid references auth.users(id) on delete cascade,
  version text not null check (char_length(version) between 1 and 32),
  platform text not null check (platform ~ '^[a-z0-9]{1,16}$'),
  arch text not null check (arch ~ '^[a-z0-9]{1,16}$'),
  sessions integer not null default 0 check (sessions between 0 and 100000),
  subagent_sessions integer not null default 0 check (subagent_sessions between 0 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (key, client, day),
  check ((client = 'desktop' and key like 'install:%') or (client = 'cli' and key like 'account:%'))
);
create index if not exists vector_usage_daily_day on public.vector_usage_daily(day);
create index if not exists vector_usage_daily_account on public.vector_usage_daily(account_id);

create table if not exists public.vector_usage_downloads (
  id bigint generated always as identity primary key,
  account_id uuid not null references auth.users(id) on delete cascade,
  target text not null check (target ~ '^[a-z0-9-]{1,32}$'),
  version text not null check (char_length(version) between 1 and 32),
  created_at timestamptz not null default now()
);
create index if not exists vector_usage_downloads_created on public.vector_usage_downloads(created_at);
create index if not exists vector_usage_downloads_account on public.vector_usage_downloads(account_id);

-- No policies: browsers never read or write these tables. Only the functions below touch them.
alter table public.vector_usage_daily enable row level security;
alter table public.vector_usage_downloads enable row level security;
revoke all on public.vector_usage_daily, public.vector_usage_downloads from public, anon, authenticated;

-- One row per install (desktop) or account (CLI) per UTC day. A repeated check-in on the same day
-- never lowers a count, and an account stays attached once known. Rows older than 400 days
-- (about 13 months) are removed here, so retention needs no separate job.
-- SECURITY DEFINER lets the server's service role check auth.users without reading that table.
create or replace function public.vector_usage_record(request jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  usage_day date := (pg_catalog.now() at time zone 'utc')::date;
  usage_client text := request->>'client';
  usage_version text := request->>'version';
  usage_platform text := request->>'platform';
  usage_arch text := request->>'arch';
  usage_account uuid;
  usage_key text;
  usage_sessions numeric := 0;
  usage_subagents numeric := 0;
begin
  if jsonb_typeof(request) is distinct from 'object'
     or usage_client is null or usage_client not in ('desktop', 'cli')
     or usage_version is null or char_length(usage_version) > 32
     or usage_version !~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
     or usage_platform is null or usage_platform !~ '^[a-z0-9]{1,16}$'
     or usage_arch is null or usage_arch !~ '^[a-z0-9]{1,16}$'
     or (request ? 'accountId' and (jsonb_typeof(request->'accountId') is distinct from 'string'
         or request->>'accountId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    return jsonb_build_object('status', 'invalid');
  end if;

  if usage_client = 'desktop' then
    if jsonb_typeof(request->'installId') is distinct from 'string'
       or request->>'installId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or usage_platform not in ('darwin', 'win32', 'linux') or usage_arch not in ('x64', 'arm64')
       or jsonb_typeof(request->'sessions') is distinct from 'number'
       or jsonb_typeof(request->'subagentSessions') is distinct from 'number' then
      return jsonb_build_object('status', 'invalid');
    end if;
    usage_sessions := (request->>'sessions')::numeric;
    usage_subagents := (request->>'subagentSessions')::numeric;
    if usage_sessions <> trunc(usage_sessions) or usage_sessions not between 0 and 100000
       or usage_subagents <> trunc(usage_subagents) or usage_subagents not between 0 and 100000 then
      return jsonb_build_object('status', 'invalid');
    end if;
  end if;

  if request ? 'accountId' then
    usage_account := (request->>'accountId')::uuid;
    -- A signed token outlives a deleted account; never attach counts to an account that is gone.
    if not exists (select 1 from auth.users u where u.id = usage_account) then
      usage_account := null;
    end if;
  end if;

  if usage_client = 'cli' then
    if usage_account is null then
      return jsonb_build_object('status', 'skipped');
    end if;
    usage_key := 'account:' || usage_account::text;
  else
    usage_key := 'install:' || (request->>'installId');
  end if;

  delete from public.vector_usage_daily where day < usage_day - 400;

  insert into public.vector_usage_daily as existing
    (key, client, day, account_id, version, platform, arch, sessions, subagent_sessions)
  values
    (usage_key, usage_client, usage_day, usage_account, usage_version, usage_platform, usage_arch,
     usage_sessions::integer, usage_subagents::integer)
  on conflict (key, client, day) do update set
    account_id = coalesce(excluded.account_id, existing.account_id),
    version = excluded.version,
    platform = excluded.platform,
    arch = excluded.arch,
    sessions = greatest(existing.sessions, excluded.sessions),
    subagent_sessions = greatest(existing.subagent_sessions, excluded.subagent_sessions),
    updated_at = pg_catalog.now();
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.vector_usage_record(jsonb) from public, anon, authenticated;
grant execute on function public.vector_usage_record(jsonb) to service_role;

-- One row per successful installer request by a signed-in account. Same 400-day retention.
create or replace function public.vector_usage_download(request jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  download_account uuid;
begin
  if jsonb_typeof(request) is distinct from 'object'
     or jsonb_typeof(request->'accountId') is distinct from 'string'
     or request->>'accountId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(request->'target') is distinct from 'string'
     or request->>'target' !~ '^[a-z0-9-]{1,32}$'
     or jsonb_typeof(request->'version') is distinct from 'string'
     or char_length(request->>'version') > 32
     or request->>'version' !~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  download_account := (request->>'accountId')::uuid;
  if not exists (select 1 from auth.users u where u.id = download_account) then
    return jsonb_build_object('status', 'skipped');
  end if;
  delete from public.vector_usage_downloads where created_at < pg_catalog.now() - interval '400 days';
  insert into public.vector_usage_downloads(account_id, target, version)
    values (download_account, request->>'target', request->>'version');
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.vector_usage_download(jsonb) from public, anon, authenticated;
grant execute on function public.vector_usage_download(jsonb) to service_role;

-- Account deletion calls this before removing the identity. It removes every day an install
-- reported once that install was linked to the account, not only the linked days. The foreign
-- keys also cascade when an identity is removed some other way.
create or replace function public.vector_usage_forget(account uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if account is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  delete from public.vector_usage_daily
    where key = 'account:' || account::text
       or key in (select linked.key from public.vector_usage_daily linked where linked.account_id = account);
  delete from public.vector_usage_downloads where account_id = account;
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.vector_usage_forget(uuid) from public, anon, authenticated;
grant execute on function public.vector_usage_forget(uuid) to service_role;

-- Aggregates for the owner's dashboard. A person is their account when any row of that install
-- or CLI was signed in, otherwise the install, so a signed-in desktop and CLI count once.
-- Weeks are ISO weeks starting Monday (UTC). Nothing returned identifies an account or install.
create or replace function public.vector_usage_summary(request jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  today date := (pg_catalog.now() at time zone 'utc')::date;
  this_week date := today - (extract(isodow from today)::integer - 1);
begin
  if jsonb_typeof(request) is distinct from 'object' then
    return null;
  end if;
  return (
    with links as (
      select d.key, max(d.account_id::text) as account
      from public.vector_usage_daily d
      group by d.key
    ),
    activity as (
      select d.day, d.client, d.key, coalesce(links.account, d.key) as actor,
        d.day - (extract(isodow from d.day)::integer - 1) as week,
        date_trunc('month', d.day::timestamp)::date as month,
        d.version, d.platform, d.arch, d.sessions, d.subagent_sessions
      from public.vector_usage_daily d
      join links on links.key = d.key
    ),
    daily as (
      select days.day,
        count(distinct activity.actor) as active,
        count(distinct activity.key) filter (where activity.client = 'desktop') as desktop,
        count(distinct activity.key) filter (where activity.client = 'cli') as cli,
        coalesce(sum(activity.sessions), 0) as sessions,
        coalesce(sum(activity.subagent_sessions), 0) as subagent_sessions
      from (select today - series.n as day from pg_catalog.generate_series(0, 89) as series(n)) as days
      left join activity on activity.day = days.day
      group by days.day
    ),
    weekly as (
      select counted.*, lag(counted.active) over (order by counted.week) as previous
      from (
        select weeks.week,
          count(distinct activity.actor) as active,
          count(distinct activity.key) filter (where activity.client = 'desktop') as desktop,
          count(distinct activity.key) filter (where activity.client = 'cli') as cli
        from (select this_week - 7 * series.n as week from pg_catalog.generate_series(0, 26) as series(n)) as weeks
        left join activity on activity.week = weeks.week
        group by weeks.week
      ) as counted
    ),
    monthly as (
      select months.month, count(distinct activity.actor) as active
      from (
        select (date_trunc('month', today::timestamp) - pg_catalog.make_interval(months => series.n))::date as month
        from pg_catalog.generate_series(0, 11) as series(n)
      ) as months
      left join activity on activity.month = months.month
      group by months.month
    ),
    rolling as (
      select
        count(distinct activity.actor) filter (where activity.day = today) as active_today,
        count(distinct activity.actor) filter (where activity.day > today - 7) as active7,
        count(distinct activity.actor) filter (where activity.day <= today - 7 and activity.day > today - 14) as previous7,
        count(distinct activity.actor) filter (where activity.day > today - 30) as active30,
        coalesce(sum(activity.sessions) filter (where activity.day > today - 7), 0) as sessions7,
        coalesce(sum(activity.subagent_sessions) filter (where activity.day > today - 7), 0) as subagent_sessions7
      from activity
    ),
    firsts as (
      select activity.actor, min(activity.week) as cohort
      from activity
      group by activity.actor
    ),
    cohort_sizes as (
      select cohorts.cohort, count(firsts.actor) as size
      from (select this_week - 7 * series.n as cohort from pg_catalog.generate_series(0, 11) as series(n)) as cohorts
      left join firsts on firsts.cohort = cohorts.cohort
      group by cohorts.cohort
    ),
    returning_actors as (
      select firsts.cohort, (activity.week - firsts.cohort) / 7 as offset_weeks,
        count(distinct activity.actor) as retained
      from firsts
      join activity on activity.actor = firsts.actor
      where activity.week > firsts.cohort and activity.week <= firsts.cohort + 28
      group by firsts.cohort, (activity.week - firsts.cohort) / 7
    ),
    signups as (
      select u.id,
        (u.created_at at time zone 'utc')::date
          - (extract(isodow from (u.created_at at time zone 'utc')::date)::integer - 1) as week,
        exists (select 1 from public.vector_usage_downloads dl where dl.account_id = u.id) as downloaded,
        exists (select 1 from public.vector_usage_daily ud where ud.account_id = u.id) as active
      from auth.users u
      where u.created_at >= ((this_week - 77)::timestamp at time zone 'utc')
    ),
    funnel as (
      select signup_weeks.week,
        count(signups.id) as signups,
        count(signups.id) filter (where signups.downloaded) as downloaded,
        count(signups.id) filter (where signups.active) as active
      from (select this_week - 7 * series.n as week from pg_catalog.generate_series(0, 11) as series(n)) as signup_weeks
      left join signups on signups.week = signup_weeks.week
      group by signup_weeks.week
    ),
    latest as (
      select distinct on (d.key) d.key, d.client, d.version, d.platform, d.arch
      from public.vector_usage_daily d
      where d.day > today - 7
      order by d.key, d.day desc
    )
    select jsonb_build_object(
      'generatedAt', to_char(pg_catalog.now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'today', today,
      'totals', jsonb_build_object(
        'accounts', (select count(*) from auth.users),
        'installs', (select count(distinct d.key) from public.vector_usage_daily d where d.client = 'desktop'),
        'cliAccounts', (select count(distinct d.key) from public.vector_usage_daily d where d.client = 'cli'),
        'downloads', (select count(*) from public.vector_usage_downloads),
        'downloadAccounts', (select count(distinct dl.account_id) from public.vector_usage_downloads dl),
        'activeToday', rolling.active_today,
        'active7', rolling.active7,
        'previous7', rolling.previous7,
        'active30', rolling.active30,
        'sessions7', rolling.sessions7,
        'subagentSessions7', rolling.subagent_sessions7
      ),
      'daily', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'day', daily.day, 'active', daily.active, 'desktop', daily.desktop, 'cli', daily.cli,
          'sessions', daily.sessions, 'subagentSessions', daily.subagent_sessions
        ) order by daily.day), '[]'::jsonb)
        from daily
      ),
      'weekly', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'week', weekly.week, 'active', weekly.active, 'desktop', weekly.desktop, 'cli', weekly.cli,
          'growth', case when weekly.previous > 0
            then round((weekly.active - weekly.previous)::numeric / weekly.previous, 4) end
        ) order by weekly.week), '[]'::jsonb)
        from weekly
        where weekly.week > this_week - 182
      ),
      'monthly', (
        select coalesce(jsonb_agg(jsonb_build_object('month', monthly.month, 'active', monthly.active)
          order by monthly.month), '[]'::jsonb)
        from monthly
      ),
      'retention', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'cohort', cohort_sizes.cohort,
          'size', cohort_sizes.size,
          'weeks', (
            select jsonb_agg(
              case when cohort_sizes.cohort + 7 * offsets.k >= this_week or cohort_sizes.size = 0 then null
                else round(coalesce(returning_actors.retained, 0)::numeric / cohort_sizes.size, 4) end
              order by offsets.k)
            from pg_catalog.generate_series(1, 4) as offsets(k)
            left join returning_actors
              on returning_actors.cohort = cohort_sizes.cohort and returning_actors.offset_weeks = offsets.k
          )
        ) order by cohort_sizes.cohort), '[]'::jsonb)
        from cohort_sizes
      ),
      'funnel', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'week', funnel.week, 'signups', funnel.signups, 'downloaded', funnel.downloaded, 'active', funnel.active
        ) order by funnel.week), '[]'::jsonb)
        from funnel
      ),
      'versions', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'client', counted.client, 'version', counted.version, 'active', counted.active
        ) order by counted.active desc, counted.client, counted.version desc), '[]'::jsonb)
        from (
          select latest.client, latest.version, count(*) as active
          from latest
          group by latest.client, latest.version
          order by count(*) desc
          limit 40
        ) as counted
      ),
      'platforms', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'client', counted.client, 'platform', counted.platform, 'arch', counted.arch, 'active', counted.active
        ) order by counted.active desc, counted.client, counted.platform, counted.arch), '[]'::jsonb)
        from (
          select latest.client, latest.platform, latest.arch, count(*) as active
          from latest
          group by latest.client, latest.platform, latest.arch
          order by count(*) desc
          limit 40
        ) as counted
      )
    )
    from rolling
  );
end;
$$;
revoke all on function public.vector_usage_summary(jsonb) from public, anon, authenticated;
grant execute on function public.vector_usage_summary(jsonb) to service_role;

commit;
