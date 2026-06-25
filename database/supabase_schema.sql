create extension if not exists pgcrypto;

create table if not exists public.public_model_aliases (
    id uuid primary key default gen_random_uuid(),
    public_model text not null unique,
    policy_name text not null,
    policy_version text not null,
    model_pool text not null,
    mode text not null,
    config jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create table if not exists public.model_registry (
    id text primary key,
    executor text not null,
    executor_model text not null,
    provider text not null,
    status text not null,
    supports jsonb not null default '{}'::jsonb,
    limits jsonb not null default '{}'::jsonb,
    cost jsonb not null default '{}'::jsonb,
    capabilities jsonb not null default '{}'::jsonb,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.policy_registry (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    version text not null,
    type text not null,
    artifact_uri text,
    status text not null,
    supported_modes jsonb not null default '[]'::jsonb,
    config jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (name, version)
);

create table if not exists public.traces (
    request_id text primary key,
    public_model text not null,
    tenant_id text,
    policy_name text not null,
    policy_version text not null,
    route_plan jsonb not null,
    selected_model text,
    candidate_models jsonb not null default '[]'::jsonb,
    fallback_used boolean not null default false,
    input_tokens int not null default 0,
    output_tokens int not null default 0,
    cost_usd numeric not null default 0,
    latency_ms int not null default 0,
    status text not null,
    error text,
    created_at timestamptz not null default now()
);

alter table public.traces add column if not exists shadow_plan jsonb;
alter table public.traces add column if not exists shadow_policy text;
alter table public.traces add column if not exists shadow_selected_model text;
alter table public.traces add column if not exists request_messages jsonb not null default '[]'::jsonb;
alter table public.traces add column if not exists request_tools jsonb;
alter table public.traces add column if not exists request_tool_choice jsonb;
alter table public.traces add column if not exists response_format jsonb;
alter table public.traces add column if not exists routing_budget jsonb not null default '{}'::jsonb;
alter table public.traces add column if not exists routing_context jsonb not null default '{}'::jsonb;
alter table public.traces add column if not exists policy_metadata jsonb not null default '{}'::jsonb;
alter table public.traces add column if not exists response_content text;
alter table public.traces add column if not exists response_tool_calls jsonb not null default '[]'::jsonb;
alter table public.traces add column if not exists execution_metadata jsonb not null default '{}'::jsonb;
alter table public.traces add column if not exists feedback_signals jsonb not null default '{}'::jsonb;
alter table public.traces add column if not exists training_labels jsonb not null default '{}'::jsonb;

create table if not exists public.benchmark_runs (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    policy_name text not null,
    policy_version text not null,
    dataset_name text not null,
    mode text not null,
    metrics jsonb not null default '{}'::jsonb,
    report jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create table if not exists public.router_artifacts (
    id uuid primary key default gen_random_uuid(),
    policy_name text not null,
    policy_version text not null,
    artifact_uri text not null,
    manifest jsonb not null default '{}'::jsonb,
    eval_report jsonb not null default '{}'::jsonb,
    status text not null,
    created_at timestamptz not null default now()
);

alter table public.public_model_aliases enable row level security;
alter table public.model_registry enable row level security;
alter table public.policy_registry enable row level security;
alter table public.traces enable row level security;
alter table public.benchmark_runs enable row level security;
alter table public.router_artifacts enable row level security;

create index if not exists traces_public_model_created_at_idx
    on public.traces (public_model, created_at desc);

create index if not exists traces_policy_created_at_idx
    on public.traces (policy_name, policy_version, created_at desc);

create index if not exists benchmark_runs_policy_created_at_idx
    on public.benchmark_runs (policy_name, policy_version, created_at desc);
