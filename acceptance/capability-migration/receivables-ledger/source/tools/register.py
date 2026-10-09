"""The old application's registration boundary; no business behavior here."""
from .ledger import open_ledger, summarize_ledger, close_ledger


def register(agent):
    for function in (open_ledger, summarize_ledger, close_ledger):
        agent.register_tool(function)
