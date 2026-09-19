# Synthetic acceptance policy

- This data is synthetic and exists only to verify the migration platform.
- Only an order returned as `approved: true` may be calculated.
- `subtotal` and `tax_rate` must be passed unchanged to `calculate_acceptance_total`.
- The Script Tool is the authoritative source for `tax_amount` and `total`.
- A missing order is not zero and must not be estimated.
