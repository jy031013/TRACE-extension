# 🛒 TRACE功能测试项目

这是一个专门为测试TRACE功能设计的最小化多文件Python项目。项目模拟了一个简单的电商系统，包含用户管理、商品管理、订单处理和支付功能。

## 📁 项目结构

```
trace_test_project/
├── main.py           # 主程序入口，演示完整业务流程
├── user.py           # 用户管理模块 (User, UserManager)
├── product.py        # 商品管理模块 (Product, ProductManager)
├── order.py          # 订单处理模块 (Order, OrderItem, OrderManager)
├── payment.py        # 支付处理模块 (Payment, PaymentMethod, PaymentManager)
├── utils.py          # 工具函数模块 (各种辅助函数)
└── README.md         # 项目说明文档 (本文件)
```

## 🎯 设计目标

### 1. 多文件关联性测试
- **依赖关系**: `order.py` → `user.py` + `product.py`
- **依赖关系**: `payment.py` → `order.py` + `utils.py`
- **依赖关系**: `main.py` → 所有模块

### 2. TRACE功能测试场景

当您修改某个文件时，TRACE应该能预测到其他相关文件也需要修改：

#### 场景1：修改用户字段
- **操作**: 在 `user.py` 的 `User` 类中添加新字段（如 `phone_number`）
- **预期**: TRACE应该建议修改 `order.py` 和 `payment.py` 中相关的用户处理逻辑

#### 场景2：修改商品结构  
- **操作**: 在 `product.py` 中为 `Product` 类添加新属性（如 `discount_rate`）
- **预期**: TRACE应该建议修改 `order.py` 中的订单计算逻辑和 `utils.py` 中的相关函数

#### 场景3：修改订单状态
- **操作**: 在 `order.py` 中修改订单状态枚举或添加新状态
- **预期**: TRACE应该建议修改 `payment.py` 中的支付状态检查逻辑

### 3. PIN功能测试场景
- 当TRACE预测出多个位置建议时，您可以PIN住重要的位置
- 再次触发预测时，被PIN的位置会保留，新预测的位置会合并显示
- 测试PIN功能在复杂项目结构中的表现

## 🚀 运行方法

### 前置条件
确保您的系统已安装Python 3.7+

### 运行步骤
1. 进入项目目录：
```bash
cd trace_test_project
```

2. 运行主程序：
```bash
python main.py
```

### 预期输出
程序会依次演示：
- 用户管理功能
- 商品管理功能  
- 订单创建流程
- 支付处理流程
- TRACE测试场景说明

## 💡 TRACE测试指南

### 步骤1：建立基线
1. 在VS Code中打开项目
2. 运行 `python main.py` 确保项目正常工作
3. 熟悉各模块间的关联关系

### 步骤2：测试TRACE预测
1. 选择一个测试场景（推荐从场景1开始）
2. 在 `user.py` 中准备添加新字段，例如：
   ```python
   def __init__(self, user_id: str, name: str, email: str, address: str = ""):
       # 在这里准备添加 phone_number 字段
   ```
3. 使用 `Ctrl+Alt+L` (Windows/Linux) 或 `Cmd+Alt+L` (macOS) 触发位置预测
4. 观察TRACE建议的修改位置是否合理

### 步骤3：测试PIN功能
1. 在位置预测结果中PIN住重要位置
2. 再次修改代码并触发预测
3. 验证PIN的位置是否保留
4. 测试PIN/UNPIN操作的交互体验

### 步骤4：测试编辑生成
1. 点击建议的位置
2. 使用 `Ctrl+Alt+E` (Windows/Linux) 或 `Cmd+Alt+E` (macOS) 生成编辑建议
3. 评估生成的代码是否符合上下文

## 📊 模块详细说明

### user.py - 用户管理模块
- **User类**: 用户数据模型，包含基本信息和业务方法
- **UserManager类**: 用户管理器，处理用户的CRUD操作
- **关键方法**: `validate_user_for_order()`, `get_user_shipping_info()`
- **测试重点**: 添加新字段时对其他模块的影响

### product.py - 商品管理模块
- **Product类**: 商品数据模型，包含价格、库存等信息
- **ProductManager类**: 商品管理器，处理商品的CRUD操作
- **关键方法**: `get_final_price()`, `check_stock_availability()`
- **测试重点**: 添加折扣字段时对价格计算的影响

### order.py - 订单处理模块
- **Order类**: 订单数据模型，包含订单项目和状态
- **OrderItem类**: 订单项目数据模型
- **OrderManager类**: 订单管理器，处理订单的创建和管理
- **关键特性**: 依赖user.py和product.py，被payment.py依赖
- **测试重点**: 修改订单状态时对支付模块的影响

### payment.py - 支付处理模块
- **Payment类**: 支付数据模型，包含支付状态和交易信息
- **PaymentManager类**: 支付管理器，处理支付流程
- **关键特性**: 依赖order.py和utils.py
- **测试重点**: 订单状态变更时的支付逻辑适配

### utils.py - 工具函数模块
- **价格计算函数**: `calculate_order_total()`, `calculate_shipping_fee()`
- **数据验证函数**: `validate_email()`, `validate_phone_number()`
- **业务辅助函数**: `generate_order_number()`, `process_payment_validation()`
- **测试重点**: 商品属性变更时的计算逻辑更新

### main.py - 主程序
- **演示功能**: 展示完整的业务流程
- **依赖关系**: 导入所有其他模块
- **测试价值**: 验证模块间集成的正确性

## 📝 项目特点

- **🎯 小而精**: 每个文件约60-80行，易于理解
- **🔗 强关联**: 模块间有明确的依赖和调用关系  
- **⚡ 易测试**: 提供多种测试场景和清晰的预期结果
- **📝 好理解**: 电商系统业务逻辑直观易懂
- **🎨 可扩展**: 容易添加新功能来创建更多测试场景

## 🛠️ 扩展建议

如果需要更复杂的测试场景，可以考虑添加：

- `database.py` - 数据持久化模块
- `notification.py` - 通知服务模块  
- `analytics.py` - 数据分析模块
- `config.py` - 配置管理模块

这些扩展模块会创建更多的跨文件依赖关系，为TRACE提供更丰富的测试场景。

## ⚠️ 注意事项

1. **Python版本**: 需要Python 3.7+支持
2. **导入路径**: 所有文件需要在同一目录下
3. **依赖关系**: 确保按照依赖顺序修改文件
4. **测试环境**: 建议在VS Code中配置TRACE扩展后使用

## 🎉 快速开始

1. **验证环境**: 运行 `python main.py` 确保项目正常
2. **开始测试**: 选择测试场景1，在user.py中准备添加字段
3. **触发TRACE**: 使用快捷键触发位置预测
4. **观察结果**: 查看TRACE是否正确预测到相关文件

祝您TRACE测试愉快！🚀