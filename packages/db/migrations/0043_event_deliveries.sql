-- Delivery of domain events to outbound webhooks, TM Forum 688 listeners and external topics. The business event is written once (lifecycle_outbox, kind EVENT);
-- the dispatcher fans it out into one delivery per subscriber and retries each on its own schedule.
CREATE TABLE event_deliveries (
  id              bigserial PRIMARY KEY,
  event_id        uuid NOT NULL,
  event_type      text NOT NULL,                       -- ORDER_CREATED, SIM_SWAPPED, ...
  tmf_type        text NOT NULL,                       -- the TM Forum event name sent to the listener
  subscription_id uuid,                                -- the webhook or TMF 688 listener (null for a topic)
  topic           text,                                -- the external topic (null for a webhook)
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','FAILED','READY','CANCELLED')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  response_status integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  CHECK ((subscription_id IS NOT NULL) <> (topic IS NOT NULL))
);
CREATE INDEX event_deliveries_due_idx ON event_deliveries (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX event_deliveries_sub_idx ON event_deliveries (subscription_id, id DESC);
CREATE INDEX event_deliveries_topic_idx ON event_deliveries (topic, id) WHERE status = 'READY';
