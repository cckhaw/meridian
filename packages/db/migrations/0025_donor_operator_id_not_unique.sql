-- An operator's MNP operator ID may be shared by more than one operator, so it is no longer unique. The name stays unique.
DROP INDEX IF EXISTS donor_operators_mnp_id_uq;
