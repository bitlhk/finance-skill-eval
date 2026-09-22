from agentscope.tool import Toolkit
from tools.refund import refund_eligibility

def build_toolkit(context):
    toolkit = Toolkit()
    toolkit.register_tool_function(refund_eligibility, preset_kwargs={'context': context})
    return toolkit
