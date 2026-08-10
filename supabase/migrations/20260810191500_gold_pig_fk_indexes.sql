CREATE INDEX IF NOT EXISTS gold_pig_booking_tokens_booking_idx
  ON public.gold_pig_booking_tokens (booking_id);

CREATE INDEX IF NOT EXISTS gold_pig_cancel_booking_idx
  ON public.gold_pig_cancellation_requests (booking_id);
