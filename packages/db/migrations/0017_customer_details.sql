-- More about a customer: date of birth, gender and a postal address (which of these the staff screens ask for is a setting).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS gender text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address jsonb;
