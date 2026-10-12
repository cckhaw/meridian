-- Indexes for lists and search on tables of millions of rows. Every list is ordered by an indexed key and continued with a keyset cursor;
-- free-text search uses prefix btrees and a GIN full-text index, never `%term%`.

-- customers: newest-first listing, word-prefix name search, e-mail / phone prefix lookup, hierarchy children
CREATE INDEX IF NOT EXISTS customers_created_idx   ON customers (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS customers_fts_idx       ON customers USING gin (to_tsvector('simple', display_name));
CREATE INDEX IF NOT EXISTS customers_email_pfx_idx ON customers (lower(email) text_pattern_ops);
CREATE INDEX IF NOT EXISTS customers_phone_pfx_idx ON customers (phone text_pattern_ops);
CREATE INDEX IF NOT EXISTS customers_parent_idx    ON customers (parent_customer_id, display_name, id) WHERE parent_customer_id IS NOT NULL;

-- services: by customer, by number prefix, and the (identifier, id) keyset inside an account
CREATE INDEX IF NOT EXISTS services_customer_idx   ON services (customer_id, status);
CREATE INDEX IF NOT EXISTS services_ident_pfx_idx  ON services (identifier text_pattern_ops);
CREATE INDEX IF NOT EXISTS services_acct_ident_idx ON services (account_id, identifier, id);

-- orders
CREATE INDEX IF NOT EXISTS orders_created_idx      ON orders (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS orders_store_idx        ON orders (store_id, created_at DESC) WHERE store_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_dealer_idx       ON orders (dealer_id, created_at DESC) WHERE dealer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_channel_idx      ON orders (channel, created_at DESC);

-- invoices
CREATE INDEX IF NOT EXISTS invoices_issued_idx     ON invoices (issue_date DESC, number DESC);
CREATE INDEX IF NOT EXISTS invoices_number_pfx_idx ON invoices (number text_pattern_ops);
CREATE INDEX IF NOT EXISTS invoices_status_idx     ON invoices (status, issue_date DESC, number DESC);
CREATE INDEX IF NOT EXISTS invoices_account_idx    ON invoices (account_id, issue_date DESC, number DESC);

-- cases
CREATE INDEX IF NOT EXISTS cases_created_idx       ON cases (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS cases_number_pfx_idx    ON cases (number text_pattern_ops);
CREATE INDEX IF NOT EXISTS cases_status_idx        ON cases (status, created_at DESC, id DESC);

-- stock, audit, users
CREATE INDEX IF NOT EXISTS inventory_sku_pfx_idx   ON inventory_stock (sku text_pattern_ops);
CREATE INDEX IF NOT EXISTS audit_actor_idx         ON audit_log (actor, id DESC);
CREATE INDEX IF NOT EXISTS users_username_pfx_idx  ON users (lower(username) text_pattern_ops);

-- catalog: name search and "everything beneath this node" (path prefix)
CREATE INDEX IF NOT EXISTS catalog_nodes_fts_idx   ON catalog_nodes USING gin (to_tsvector('simple', name || ' ' || code));
CREATE INDEX IF NOT EXISTS catalog_nodes_path_pfx_idx ON catalog_nodes (path text_pattern_ops);
CREATE INDEX IF NOT EXISTS catalog_nodes_level_idx ON catalog_nodes (level, status, sort_order, name, id);
CREATE INDEX IF NOT EXISTS order_lines_offer_idx   ON order_lines (offer_id);

-- customer hierarchy navigation: accounts of a customer in creation order, memberships in both directions
CREATE INDEX IF NOT EXISTS accounts_customer_created_idx ON accounts (customer_id, created_at, id);
CREATE INDEX IF NOT EXISTS group_memberships_member_idx  ON group_memberships (member_customer_id);
CREATE INDEX IF NOT EXISTS group_memberships_group_idx   ON group_memberships (group_customer_id, role);
