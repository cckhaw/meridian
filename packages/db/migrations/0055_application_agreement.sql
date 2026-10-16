-- The agreement a store-front or counter applicant has signed on screen, kept (signature picture encrypted) until checkout turns it into the signed documents of the order.
ALTER TABLE applications ADD COLUMN agreement jsonb;
