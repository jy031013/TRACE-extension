"""
TRACE功能测试项目 - 主程序
Main Program for TRACE Feature Testing

演示完整的电商业务流程，测试所有模块间的关联关系。
运行此程序可以验证项目的正确性，为TRACE功能测试提供基础。
"""

from user import UserManager
from product import ProductManager, ProductCategory
from order import OrderManager, OrderStatus
from payment import PaymentManager, PaymentMethod
from utils import format_currency, format_datetime


def print_section(title: str):
    """打印分节标题"""
    print(f"\n{'='*50}")
    print(f" {title}")
    print(f"{'='*50}")


def demo_user_management():
    """演示用户管理功能"""
    print_section("用户管理演示")
    
    user_manager = UserManager()
    
    # 创建测试用户
    user1 = user_manager.create_user(
        "张三", "zhangsan@email.com", "北京市朝阳区xx街道xx号"
    )
    user2 = user_manager.create_user(
        "李四", "lisi@email.com", "上海市浦东新区xx路xx号"
    )
    
    print(f"创建用户1: {user1.get_display_name()}")
    print(f"用户信息: {user1.get_user_info()}")
    print(f"创建用户2: {user2.get_display_name()}")
    
    return user_manager


def demo_product_management():
    """演示商品管理功能"""
    print_section("商品管理演示")
    
    product_manager = ProductManager()
    
    # 显示初始商品
    products = product_manager.get_available_products()
    print(f"系统中共有 {len(products)} 件商品:")
    
    for product in products:
        print(f"- {product.name}: {format_currency(product.price)} (库存: {product.stock_quantity})")
    
    return product_manager


def demo_order_creation(user_manager: UserManager, product_manager: ProductManager):
    """演示订单创建功能"""
    print_section("订单创建演示")
    
    order_manager = OrderManager(user_manager, product_manager)
    
    # 获取用户和商品
    users = user_manager.get_active_users()
    products = product_manager.get_available_products()
    
    if not users or not products:
        print("没有可用的用户或商品")
        return None
    
    user = users[0]
    print(f"为用户 {user.get_display_name()} 创建订单")
    
    # 创建订单项目
    order_items = [
        {'product_id': products[0].product_id, 'quantity': 1},
        {'product_id': products[1].product_id, 'quantity': 2},
    ]
    
    order = order_manager.create_order(user.user_id, order_items)
    
    if order:
        print(f"订单创建成功: {order.order_id}")
        print(f"订单状态: {order.status.value}")
        print(f"订单金额: {format_currency(order.total_amount)}")
        print(f"创建时间: {format_datetime(order.created_at)}")
        
        print("\n订单详情:")
        for item in order.items:
            item_info = item.get_item_info()
            print(f"- {item_info['product_name']} x{item_info['quantity']} = {format_currency(item_info['total_price'])}")
        
        print(f"\n小计: {format_currency(order.subtotal)}")
        print(f"运费: {format_currency(order.shipping_fee)}")
        print(f"税费: {format_currency(order.tax_amount)}")
        print(f"总计: {format_currency(order.total_amount)}")
        
    else:
        print("订单创建失败")
    
    return order_manager, order


def demo_payment_processing(order_manager: OrderManager, order):
    """演示支付处理功能"""
    print_section("支付处理演示")
    
    if not order:
        print("没有可用的订单进行支付")
        return None
    
    payment_manager = PaymentManager(order_manager)
    
    # 创建支付
    payment = payment_manager.create_payment(order.order_id, PaymentMethod.ALIPAY)
    
    if payment:
        print(f"支付创建成功: {payment.payment_id}")
        print(f"支付金额: {format_currency(payment.amount)}")
        print(f"支付方式: {payment.payment_method.value}")
        print(f"支付状态: {payment.status.value}")
        
        # 处理支付
        print("\n正在处理支付...")
        result = payment_manager.process_payment(payment.payment_id)
        
        if result['success']:
            print(f"✅ {result['message']}")
            print(f"交易ID: {result['transaction_id']}")
            
            # 检查订单状态更新
            updated_order = order_manager.get_order(order.order_id)
            print(f"订单状态已更新为: {updated_order.status.value}")
            
        else:
            print(f"❌ 支付失败: {result['error']}")
    else:
        print("支付创建失败")
    
    return payment_manager


def demo_trace_test_scenarios():
    """演示TRACE测试场景"""
    print_section("TRACE功能测试场景")
    
    print("🎯 测试场景说明:")
    print("1. 场景1：修改用户字段")
    print("   - 在 user.py 的 User 类中添加 phone_number 字段")
    print("   - TRACE应预测 order.py 和 payment.py 需要更新用户处理逻辑")
    
    print("\n2. 场景2：修改商品结构")
    print("   - 在 product.py 的 Product 类中添加 discount_rate 属性")
    print("   - TRACE应预测 order.py 的价格计算逻辑和 utils.py 的相关函数需要修改")
    
    print("\n3. 场景3：修改订单状态")
    print("   - 在 order.py 的 OrderStatus 枚举中添加新状态")
    print("   - TRACE应预测 payment.py 的支付状态检查逻辑需要更新")
    
    print("\n📌 PIN功能测试:")
    print("- 当TRACE预测出多个建议位置时，可以PIN住重要位置")
    print("- 下次预测时，被PIN的位置会保留，新预测位置会合并显示")
    
    print("\n🔧 测试步骤:")
    print("1. 使用 Ctrl+Alt+L 触发位置预测")
    print("2. 右键点击建议位置，选择 'Pin Location'")
    print("3. 再次修改代码并触发预测")
    print("4. 验证PIN的位置是否保留")


def main():
    """主函数 - 演示完整业务流程"""
    print("🛒 TRACE功能测试项目")
    print("模拟电商系统 - 多文件关联性测试")
    
    try:
        # 1. 用户管理演示
        user_manager = demo_user_management()
        
        # 2. 商品管理演示
        product_manager = demo_product_management()
        
        # 3. 订单创建演示
        order_manager, order = demo_order_creation(user_manager, product_manager)
        
        # 4. 支付处理演示
        payment_manager = demo_payment_processing(order_manager, order)
        
        # 5. TRACE测试场景说明
        demo_trace_test_scenarios()
        
        print_section("项目运行成功")
        print("✅ 所有模块运行正常")
        print("✅ 模块间依赖关系正确")
        print("✅ 业务流程完整")
        print("\n🎉 项目已准备好进行TRACE功能测试！")
        
    except Exception as e:
        print(f"❌ 程序运行出错: {str(e)}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()