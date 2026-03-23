"""
工具函数模块 - Utility Functions Module

提供各种辅助函数，供其他模块调用，特别是订单计算和支付处理相关的功能。
当product.py中的Product类添加新属性时，此模块中的相关函数需要更新。
"""

import re
from typing import List, Dict, Optional
from datetime import datetime, timedelta
import random
import string


def format_currency(amount: float) -> str:
    """格式化货币显示"""
    return f"¥{amount:,.2f}"


def generate_order_number() -> str:
    """生成订单号"""
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    random_suffix = ''.join(random.choices(string.digits, k=4))
    return f"ORD{timestamp}{random_suffix}"


def generate_payment_id() -> str:
    """生成支付ID - payment.py会调用此函数"""
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    random_suffix = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    return f"PAY{timestamp}{random_suffix}"


def calculate_shipping_fee(total_amount: float, address: str) -> float:
    """计算运费 - order.py会调用此函数"""
    # 简单的运费计算逻辑
    if total_amount >= 199:
        return 0.0  # 满199免邮
    elif "北京" in address or "上海" in address or "广州" in address or "深圳" in address:
        return 10.0  # 一线城市运费
    else:
        return 15.0  # 其他地区运费


def calculate_tax(subtotal: float) -> float:
    """计算税费 - order.py会调用此函数"""
    # 简单的税费计算（13%）
    return subtotal * 0.13


def calculate_order_total(items: List[Dict], shipping_address: str) -> Dict:
    """计算订单总金额 - order.py会调用此函数
    
    当product.py中添加discount_rate属性时，此函数需要更新以支持折扣计算
    """
    subtotal = 0.0
    
    for item in items:
        # 当Product类添加discount_rate时，这里需要更新计算逻辑
        item_total = item.get('price', 0.0) * item.get('quantity', 1)
        subtotal += item_total
    
    shipping_fee = calculate_shipping_fee(subtotal, shipping_address)
    tax_amount = calculate_tax(subtotal)
    total_amount = subtotal + shipping_fee + tax_amount
    
    return {
        'subtotal': subtotal,
        'shipping_fee': shipping_fee,
        'tax_amount': tax_amount,
        'total_amount': total_amount,
        'formatted_total': format_currency(total_amount)
    }


def validate_email(email: str) -> bool:
    """验证邮箱格式"""
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return re.match(pattern, email) is not None


def validate_phone_number(phone: str) -> bool:
    """验证手机号格式 - 当user.py添加phone_number字段时使用"""
    pattern = r'^1[3-9]\d{9}$'
    return re.match(pattern, phone) is not None


def generate_tracking_number() -> str:
    """生成快递单号"""
    timestamp = datetime.now().strftime("%Y%m%d")
    random_suffix = ''.join(random.choices(string.digits, k=10))
    return f"SF{timestamp}{random_suffix}"


def format_datetime(dt: datetime) -> str:
    """格式化日期时间显示"""
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def calculate_estimated_delivery(order_date: datetime, address: str) -> datetime:
    """计算预计送达时间"""
    if "北京" in address or "上海" in address or "广州" in address or "深圳" in address:
        # 一线城市，1-2天送达
        days = random.randint(1, 2)
    else:
        # 其他地区，2-5天送达
        days = random.randint(2, 5)
    
    return order_date + timedelta(days=days)


def process_payment_validation(payment_data: Dict) -> Dict:
    """支付数据验证处理 - payment.py会调用此函数"""
    errors = []
    
    # 验证必要字段
    required_fields = ['amount', 'payment_method', 'order_id']
    for field in required_fields:
        if field not in payment_data or not payment_data[field]:
            errors.append(f"缺少必要字段: {field}")
    
    # 验证金额
    if 'amount' in payment_data:
        try:
            amount = float(payment_data['amount'])
            if amount <= 0:
                errors.append("支付金额必须大于0")
        except (ValueError, TypeError):
            errors.append("支付金额格式不正确")
    
    return {
        'is_valid': len(errors) == 0,
        'errors': errors,
        'payment_id': generate_payment_id() if len(errors) == 0 else None
    }