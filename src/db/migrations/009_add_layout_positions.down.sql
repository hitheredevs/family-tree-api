DROP INDEX IF EXISTS idx_person_layout_xy;

ALTER TABLE person DROP COLUMN IF EXISTS layout_y;
ALTER TABLE person DROP COLUMN IF EXISTS layout_x;
