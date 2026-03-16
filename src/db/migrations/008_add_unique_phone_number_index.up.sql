CREATE UNIQUE INDEX IF NOT EXISTS idx_person_phone_number_unique
  ON person(phone_number)
  WHERE phone_number IS NOT NULL AND is_deleted = false;