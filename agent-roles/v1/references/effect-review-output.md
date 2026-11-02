只返回 JSON：{"status":"PRODUCED","review":{"recommendation":"KEEP_CANDIDATE 或 CONTINUE_CANDIDATE 或 KEEP_BASELINE 或 INCONCLUSIVE","reason":"依据与归因限制","improvements":["有证据的改善"],"regressions":["有证据的回归"],"evidenceIds":["实际引用的 evidenceId"],"tradeoff":"有回退时说明与目标的取舍；无回退可省略","nextFocus":["CONTINUE_CANDIDATE 必填的下一轮修复方向；其他情况可省略"]}}。
缺少材料时返回 {"status":"ABSTAINED","reason":"具体缺口"}，不伪造评测结论。
