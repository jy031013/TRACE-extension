from app.checkout import create_order_summary


def main() -> None:
    summary = create_order_summary(
        customer_name="Mina",
        tier="member",
        cart_items=[
            ("notebook", 2),
            ("pen", 3),
        ],
    )
    print(summary)


if __name__ == "__main__":
    main()
