-- Minimal stand-in for what a Supabase database provides before our migrations run, so the migrations,
-- RLS and functions can be tested in-process (PGlite) without Docker. TEST HARNESS ONLY — never applied to a
-- real Supabase project, which already has all of this.
--
-- Mirrors Supabase: roles anon / authenticated / service_role (BYPASSRLS), auth.users, auth.uid() and
-- auth.jwt() reading the request.jwt.claims setting, and the default grants Supabase gives to API roles
-- (RLS, not grants, is what protects tables).

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text unique,
  created_at timestamptz not null default now()
);

create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create function auth.role() returns text
language sql stable as $$
  select auth.jwt() ->> 'role'
$$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
