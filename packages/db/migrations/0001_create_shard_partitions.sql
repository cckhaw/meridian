-- Creates logical-shard list partitions and hash sub-partitions for the dev cluster.
-- Production runs this per physical cluster for only the shards that cluster owns (see shard_map).
DO $$
DECLARE s int; t text; r int;
BEGIN
  FOR s IN 0..15 LOOP   -- dev: 16 of 1024 shards
    FOREACH t IN ARRAY ARRAY['customers','accounts','orders'] LOOP
      EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES IN (%s)', t || '_s' || s, t, s);
    END LOOP;
  END LOOP;
  FOR r IN 0..7 LOOP
    EXECUTE format('CREATE TABLE services_h%s PARTITION OF services FOR VALUES WITH (MODULUS 8, REMAINDER %s)', r, r);
    EXECUTE format('CREATE TABLE order_lines_h%s PARTITION OF order_lines FOR VALUES WITH (MODULUS 8, REMAINDER %s)', r, r);
  END LOOP;
END $$;
