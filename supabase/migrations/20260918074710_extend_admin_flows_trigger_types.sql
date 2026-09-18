-- Keep the database constraint aligned with every trigger accepted by
-- src/routes/adminFlows.js. crm_staging is optional on clean installations,
-- but this project uses it for the isolated teammate test site.
do $$
declare
  target_schema text;
begin
  foreach target_schema in array array['public', 'crm_staging']
  loop
    if to_regclass(format('%I.admin_flows', target_schema)) is not null then
      execute format(
        'alter table %I.admin_flows drop constraint if exists admin_flows_trigger_check',
        target_schema
      );
      execute format(
        'alter table %I.admin_flows add constraint admin_flows_trigger_check check (
          trigger_type = any (array[
            ''follow'',
            ''list_join'',
            ''event'',
            ''schedule'',
            ''game_play'',
            ''broadcast_click'',
            ''restaurant_click'',
            ''inactivity'',
            ''streak_risk'',
            ''rich_menu_tap'',
            ''campaign_open''
          ]::text[])
        ) not valid',
        target_schema
      );
      execute format(
        'alter table %I.admin_flows validate constraint admin_flows_trigger_check',
        target_schema
      );
    end if;
  end loop;
end $$;
