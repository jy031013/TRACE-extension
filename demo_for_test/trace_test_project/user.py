"""
用户管理模块 - User Management Module

提供用户数据结构和管理功能，支持TRACE功能测试中的用户字段修改场景。
当修改User类时，TRACE应该能预测到order.py和payment.py中的相关逻辑需要更新。
"""

from datetime import datetime
from typing import Dict, List, Optional


class User:
    """用户数据模型
    
    测试场景：在此类中添加新字段（如phone_number），
    TRACE应预测order.py和payment.py需要相应修改。
    """
    
    def __init__(self, user_id: str, name: str, email: str, address: str = "", phone_number: Optional[str] = None):
        self.user_id = user_id
        self.name = name
        self.email = email
        self.address = address
        self.phone_number = phone_number
        self.created_at = datetime.now()
        self.is_active = True
        # 预留字段用于TRACE测试 - 添加phone_number时测试关联预测
        
    def get_display_name(self) -> str:
        """获取用户显示名称"""
        return f"{self.name} ({self.email})"
    
    def update_address(self, new_address: str) -> None:
        """更新用户地址"""
        self.address = new_address
    
    def deactivate(self) -> None:
        """停用用户账户"""
        self.is_active = False
    
    def get_user_info(self) -> Dict:
        """获取用户信息字典 - 订单和支付模块会调用此方法"""
        return {
            'user_id': self.user_id,
            'name': self.name,
            'email': self.email,
            'address': self.address,
            'phone_number': self.phone_number,
            'is_active': self.is_active
        }


class UserManager:
    """用户管理器
    
    管理所有用户的创建、查询、更新等操作。
    其他模块通过此类访问用户数据。
    """
    
    def __init__(self):
        self.users: Dict[str, User] = {}
        self._next_user_id = 1
    
    def create_user(self, name: str, email: str, address: str = "") -> User:
        """创建新用户"""
        user_id = f"USER_{self._next_user_id:04d}"
        self._next_user_id += 1
        
        user = User(user_id, name, email, address)
        self.users[user_id] = user
        return user
    
    def get_user(self, user_id: str) -> Optional[User]:
        """根据ID获取用户"""
        return self.users.get(user_id)
    
    def get_active_users(self) -> List[User]:
        """获取所有活跃用户"""
        return [user for user in self.users.values() if user.is_active]
    
    def validate_user_for_order(self, user_id: str) -> bool:
        """验证用户是否可以下单 - order.py会调用此方法"""
        user = self.get_user(user_id)
        return user is not None and user.is_active
    
    def get_user_shipping_info(self, user_id: str) -> Optional[Dict]:
        """获取用户配送信息 - order.py会调用此方法"""
        user = self.get_user(user_id)
        if user and user.is_active and user.address:
            return {
                'name': user.name,
                'address': user.address,
                'email': user.email
            }
        return None