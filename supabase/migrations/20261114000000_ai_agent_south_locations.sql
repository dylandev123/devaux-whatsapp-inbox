-- South Deliveries list, editable in AI settings.
--
-- Additive and safe to run at any time: one nullable column. While it is null (or the migration has not been run) the app uses
-- its built-in list (Vieux Fort, Laborie, Choiseul, Soufrière, Micoud, Dennery). The app reads and writes the column only when it exists.
--
-- Shape: [{ "group": "Soufrière", "names": ["Soufrière", "Anse Chastanet", "St Remy"] }, ...]
-- `group` is the heading staff see; every name (the group's own name included) is a place that counts as that destination.

alter table public.ai_agent_settings
  add column if not exists south_locations jsonb;

comment on column public.ai_agent_settings.south_locations is
  'South Deliveries destinations: [{group, names[]}]. Null = built-in list. Edited in Admin → AI agent → Settings.';
