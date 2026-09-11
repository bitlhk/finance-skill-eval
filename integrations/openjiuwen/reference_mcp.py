"""Read-only synthetic business snapshot. Live tool execution, never bank production data."""
from copy import deepcopy
from fastmcp import FastMCP
try:
    from .role_fixtures import insurance_customer, register_tools
except ImportError:
    from role_fixtures import insurance_customer, register_tools

mcp = FastMCP("Finance Eval - synthetic financial role snapshots v1")
register_tools(mcp)
SOURCE = {"source": "finance-eval-synthetic-fixture", "snapshotVersion": "wealth-demo-v1", "asOf": "2026-09-05", "synthetic": True}
PRODUCTS = [
    {"productId": "P009", "name": "演示现金管理", "risk": "R1", "availability": "AVAILABLE", "redemption": "T+1工作日到账，非即时到账", "lockDays": 0, "fee": "管理费0.15%/年，无申赎费", "guaranteed": False},
    {"productId": "P001", "name": "演示封闭固收", "risk": "R2", "availability": "AVAILABLE", "redemption": "323天封闭期内不可赎回", "lockDays": 323, "fee": "管理费0.25%/年", "guaranteed": False},
    {"productId": "F000343", "name": "演示混合基金", "risk": "R4", "availability": "AVAILABLE", "redemption": "T+3工作日到账", "lockDays": 0, "fee": "申购费0.8%，管理费1.2%/年，持有不足7日赎回费1.5%", "guaranteed": False, "riskDisclosure": "权益净值波动，可能本金亏损，适合长期资金，不计入高流动性底线"},
]


def customer(customer_id):
    if customer_id == "C005":
        return {"customerId": "C005", "name": "陈明（模拟）", "riskLevel": "C4", "riskScaleLabel": "机构内部编码，不代表统一风险偏好", "assessmentStatus": "VALID", "validUntil": "2027-03-11", "objective": "三年以上长期增值兼顾流动性", "knownCashNeeds": [], "holdings": [], "holdingsScope": "仅本行账户，外部资产未核实", "liabilities": "客户本次确认无借款", "investmentExperience": "5年公募基金经验", "lossTolerance": "可接受本次投资短期浮亏7.5万元，但不是最大损失保证"}
    if customer_id == "C006":
        return {"customerId": "C006", "name": "王建国（模拟）", "riskLevel": "C3", "assessmentStatus": "VALID", "maturityAmount": 3000000, "maturityDate": "2026-09-10", "notes": "未来3至6个月可能支付200万元设备款，支付主体及日期待客户确认；客户希望到期承接收益高一点。", "holdingsScope": "仅本行数据，家庭资产及负债缺失"}
    raise ValueError("Customer not in authorized demo snapshot")


@mcp.tool(annotations={"readOnlyHint": True})
def get_customer_profile(customer_id: str) -> dict:
    """Read synthetic wealth customer C005/C006 or auto-insurance customer I001; includes source and gaps."""
    if customer_id == "I001":
        return {**SOURCE, "snapshotVersion": "roles-demo-v1", "profile": insurance_customer(customer_id)}
    return {**SOURCE, "profile": customer(customer_id)}


@mcp.tool(annotations={"readOnlyHint": True})
def get_customer_portfolio(customer_id: str) -> dict:
    """Read the current bank-only holdings snapshot; an empty result does not prove no other assets."""
    c = customer(customer_id)
    return {**SOURCE, "customerId": customer_id, "holdings": c.get("holdings", []), "scope": c["holdingsScope"]}


@mcp.tool(annotations={"readOnlyHint": True})
def get_wealth_policy_basis() -> dict:
    """Current synthetic institution policy summary for the demo; not regulatory guidance."""
    return {**SOURCE, "policyVersion": "demo-wealth-policy-v1", "rules": ["只使用已核验合格候选，不以等级标签直接推导仓位", "封闭产品不能承载流动性底线", "建议不构成收益保证，比例及费用须明确", "客户确认后方可进入业务办理"]}


@mcp.tool(annotations={"readOnlyHint": True})
def prepare_wealth_allocation_context(customer_id: str, investable_amount: float = 750000, investment_horizon_years: float = 3, liquidity_ratio: float = 0.2) -> dict:
    """Read unified verified synthetic profile, policy, holdings and eligible product shelf. C005 demo budget 750000 CNY, minimum liquidity 20%."""
    c = customer(customer_id)
    if customer_id != "C005":
        return {**SOURCE, "readiness": "DEGRADED", "profile": c, "missing": ["设备款来源、金额、支付时点及可承受回撤"], "eligibleProducts": []}
    if (investable_amount, investment_horizon_years, liquidity_ratio) != (750000, 3, 0.2):
        return {**SOURCE, "readiness": "DEGRADED", "profile": c, "eligibleProducts": [],
                "missing": ["本模拟快照只核验了75万元、3年期限、20%流动性要求；新的约束需要重新确认"]}
    return {**SOURCE, "readiness": "READY", "profile": c, "policy": get_wealth_policy_basis.fn() if hasattr(get_wealth_policy_basis, "fn") else {"version": "demo-wealth-policy-v1"},
            "currentPortfolio": [], "investableAmount": 750000, "liquidityFloor": 150000, "minimumHorizonYears": 3,
            "calculationBasis": "本次预算750000元乘以客户要求20%，不是客户全资产口径", "eligibleProducts": deepcopy(PRODUCTS),
            "excludedProducts": [{"productId": "P004", "reason": "停售"}], "missing": ["外部资产未接入，不可计算全家庭配置前后集中度"]}


@mcp.tool(annotations={"readOnlyHint": True})
def wealth_assistant_product_info(product_id: str) -> dict:
    """Read verified product terms from the fixed demo shelf."""
    found = next((p for p in PRODUCTS if p["productId"] == product_id), None)
    if not found:
        raise ValueError("Product unavailable in snapshot")
    return {**SOURCE, "product": deepcopy(found)}


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="127.0.0.1", port=56363)
