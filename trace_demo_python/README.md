# Minimal Python Demo For TRACE

This demo is intentionally small, but it still has a real cross-file call chain:

- `main.py` starts the app
- `app/checkout.py` coordinates the order flow
- `app/catalog.py` stores product data
- `app/pricing.py` contains pricing rules
- `app/notifications.py` builds the user-facing summary
- `tests/test_checkout.py` checks the result

## Run

```bash
cd trace_demo_python
python main.py
python -m unittest discover -s tests
```

## Good TRACE Test Ideas

1. Change the member discount in `app/pricing.py` from `0.10` to `0.15`
2. Rename `delivery_fee` to `shipping_fee`
3. Add a new `vip` customer tier
4. Change the tax rate and see whether TRACE suggests updates in tests and summary text

These changes usually create follow-up edits across multiple files, which makes them useful for testing location prediction and edit generation.
