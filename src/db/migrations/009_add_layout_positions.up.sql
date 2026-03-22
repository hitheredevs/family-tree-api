-- Add pre-computed layout positions to person table.
-- These are populated by the server-side layout engine and queried
-- by the frontend viewport API for efficient spatial loading.

ALTER TABLE person
ADD COLUMN IF NOT EXISTS layout_x DOUBLE PRECISION;

ALTER TABLE person
ADD COLUMN IF NOT EXISTS layout_y DOUBLE PRECISION;

-- Index for fast spatial range queries (viewport loading)
CREATE INDEX IF NOT EXISTS idx_person_layout_xy
ON person (layout_x, layout_y)
WHERE layout_x IS NOT NULL AND layout_y IS NOT NULL AND is_deleted = false;
