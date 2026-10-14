-- What was called a "routing code" is the operator ID used for mobile number portability (MNP).
ALTER TABLE donor_operators RENAME COLUMN routing_code TO mnp_operator_id;
ALTER INDEX donor_operators_code_uq RENAME TO donor_operators_mnp_id_uq;
ALTER TABLE port_in_requests RENAME COLUMN donor_routing_code TO donor_mnp_operator_id;
