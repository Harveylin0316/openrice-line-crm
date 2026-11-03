-- Disable capture/send first. Refuse to delete any captured history.
DO $$ BEGIN
  IF current_schema() <> 'crm_staging' THEN
    RAISE EXCEPTION 'OR mission rollback requires crm_staging schema';
  END IF;
  IF to_regclass('crm_staging.or_mission_follow_notifications') IS NOT NULL THEN
    IF EXISTS(SELECT FROM crm_staging.or_mission_follow_notifications) THEN
      RAISE EXCEPTION 'Keep notification history; disable flags and roll back code only';
    END IF;
    DROP TABLE crm_staging.or_mission_follow_notifications;
  END IF;
END $$;
