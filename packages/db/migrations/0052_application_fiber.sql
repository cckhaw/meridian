-- A store-front application that includes fibre keeps the port it is holding while the customer checks out, so checkout can confirm it for the order.
ALTER TABLE applications ADD COLUMN fiber jsonb;
