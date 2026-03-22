import unittest

from app.checkout import create_order_summary
from app.pricing import calculate_total


class CheckoutTests(unittest.TestCase):
    def test_total_for_member_order(self) -> None:
        pricing = calculate_total(
            cart_items=[("notebook", 2), ("pen", 3)],
            tier="member",
        )

        self.assertEqual(
            pricing,
            {
                "subtotal": 31.5,
                "discount": 3.15,
                "tax": 1.98,
                "delivery_fee": 5.0,
                "total": 35.33,
            },
        )

    def test_summary_contains_customer_name(self) -> None:
        summary = create_order_summary(
            customer_name="Mina",
            tier="member",
            cart_items=[("notebook", 1)],
        )

        self.assertIn("Order for Mina", summary)
        self.assertIn("total=$16.56", summary)


if __name__ == "__main__":
    unittest.main()
