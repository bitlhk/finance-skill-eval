"""Parse inert uploaded text from stdin. Never import or execute uploaded modules."""
import ast
import io
import json
import posixpath
import re
import sys
import tokenize


def scan(files):
    findings, coverage, tools = [], [], []

    def add(path, line, kind, reason, impact, fix, confidence="HIGH", layer="DEPENDENCY", symbol=None):
        lines = files[path].splitlines()
        findings.append(dict(path=path, line=max(1, line), endLine=max(1, line),
            snippet=lines[line - 1][:900] if 0 < line <= len(lines) else "",
            dependencyType=kind, reason=reason, impact=impact, suggestion=fix,
            confidence=confidence, layer=layer, symbol=symbol))

    for path, text in files.items():
        status = "TEXT_INSPECTED"
        lower_path = path.lower()
        if lower_path.endswith(".py"):
            status = "AST_PARSED"
            try:
                tree = ast.parse(text, filename=path)
            except (SyntaxError, ValueError, RecursionError) as error:
                add(path, getattr(error, "lineno", 1) or 1, "UNPARSED_CODE", "Python 语法无法完整解析", "不能判断全部运行依赖", "提供完整可解析源码；不要执行该文件", layer="UNKNOWN")
                coverage.append(dict(path=path, status="PARSE_FAILED"))
                continue
            aliases = {}
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        aliases[alias.asname or alias.name.split('.')[0]] = alias.name
                        if alias.name.split('.')[0] in ("agentscope", "openjiuwen", "langchain", "langgraph"):
                            add(path, node.lineno, "SDK_IMPORT", "源码导入运行框架 SDK", "工具实现或宿主与框架绑定；不等于业务 SOP 被污染", "将 SDK 类型与注册留在薄适配层", symbol=alias.name)
                        elif alias.name.split('.')[0] not in sys.stdlib_module_names and alias.name.replace('.', '/') + '.py' not in files and alias.name.replace('.', '/') + '/__init__.py' not in files:
                            add(path, node.lineno, "EXTERNAL_MODULE", "导入包不在随包源码或 Python 标准库中", "需要依赖锁确认安装来源与版本", "由原工程提供依赖锁；不自动安装第三方包", layer="UNKNOWN", symbol=alias.name)
                if isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    for alias in node.names:
                        aliases[alias.asname or alias.name] = module + "." + alias.name
                    if module.split('.')[0] in ("agentscope", "openjiuwen", "langchain", "langgraph"):
                        add(path, node.lineno, "SDK_IMPORT", "源码导入运行框架 SDK", "需要相应版本依赖，尚未核验可运行性", "将 SDK 引用限制在 Runtime 适配层", symbol=module)
                    elif not node.level and module.split('.')[0] not in sys.stdlib_module_names and module.replace('.', '/') + '.py' not in files and module.replace('.', '/') + '/__init__.py' not in files:
                        add(path, node.lineno, "EXTERNAL_MODULE", "导入包不在随包源码或 Python 标准库中", "需要依赖锁确认安装来源与版本", "由原工程提供依赖锁；不自动安装第三方包", layer="UNKNOWN", symbol=module)
                    if node.level:
                        directory = posixpath.dirname(path)
                        for _ in range(node.level - 1):
                            directory = posixpath.dirname(directory)
                        target = posixpath.join(directory, module.replace('.', '/'))
                        present = target + '.py' in files or target + '/__init__.py' in files
                        if not module:
                            present = all(posixpath.join(directory, n.name + '.py') in files for n in node.names)
                        if not present:
                            add(path, node.lineno, "MISSING_MODULE", "相对导入模块未随包提供", "原工程基线无法确认可运行", "由原工程负责人补齐模块及依赖锁；不要猜测实现", layer="UNKNOWN", symbol='.' * node.level + module)

            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith('_'):
                    params = [a.arg for a in node.args.args if a.arg not in ('self', 'cls')]
                    tools.append(dict(path=path, line=node.lineno, name=node.name, parameters=params,
                        asyncFunction=isinstance(node, ast.AsyncFunctionDef), status="DECLARATION_ONLY_NOT_TOOL_SCHEMA"))
                if not isinstance(node, ast.Call):
                    continue
                func = ast.unparse(node.func)
                root = func.split('.')[0]
                resolved = aliases.get(root, root) + func[len(root):]
                if resolved in ('agentscope.tool.ToolResponse', 'agentscope.message.TextBlock'):
                    add(path, node.lineno, "SDK_RESULT", "工具结果构造成 AgentScope 专有返回类型", "返回结果边界需要转换，不应改写业务事实", "中立结果保留原值和缺数语义，由 AgentScope 薄适配包装", symbol=resolved)
                if isinstance(node.func, ast.Attribute) and node.func.attr in ('register_tool_function', 'register_tool', 'register_agent_skill'):
                    add(path, node.lineno, "TOOL_REGISTRATION", "宿主调用工具或 Skill 注册接口", "正常宿主职责；跨 Runtime 需对应注册，不是业务方法污染", "保留业务方法，迁移注册代码至目标 Host 并独立测试", layer="HOST", symbol=func)
                    for keyword in node.keywords:
                        if keyword.arg in ('json_schema', 'input_schema', 'schema'):
                            add(path, keyword.value.lineno, "TOOL_SCHEMA", "注册时显式传入工具 Schema", "目标框架需保留参数展开、必填项及结果语义", "核对实际 Schema 来源与返回合同；不根据函数名猜测字段", layer="HOST", symbol=keyword.arg)
                if isinstance(node.func, ast.Attribute) and node.func.attr in ('load_memory', 'save_memory', 'get_context', 'load_state', 'save_state'):
                    add(path, node.lineno, "STATE_CONTEXT", "调用状态、记忆或上下文接口", "生命周期、隔离与撤权清理需要宿主对应实现", "核对当前调用主体与会话归属；不要把记忆内容当授权", layer="HOST", symbol=func)
                if func in ('eval', 'exec', '__import__') or resolved == 'importlib.import_module':
                    add(path, node.lineno, "DYNAMIC_DEPENDENCY", "执行期动态加载或执行代码", "静态扫描不能确定最终依赖", "人工审阅加载目标；受控验证前禁止执行", layer="UNKNOWN", symbol=func)
                if func in ('asyncio.create_subprocess_shell', 'os.system', 'subprocess.run', 'subprocess.Popen'):
                    add(path, node.lineno, "EXECUTION_SURFACE", "存在外部进程调用实现", "存在可执行面，但定义存在不等于已注册或已执行", "保持禁用；由安全负责人审核实际工具白名单", layer="REVIEW", symbol=func)
                if any(node is entry.value for entry in tree.body if isinstance(entry, ast.Expr)):
                    add(path, node.lineno, "TOP_LEVEL_CALL", "模块顶层有调用表达式", "直接导入可能产生副作用", "拆分显式启动入口；不得为诊断直接 import", layer="REVIEW", symbol=func)
            # Comments are never imports, but explicit omitted-code notices are evidence of incompleteness.
            for token in tokenize.generate_tokens(io.StringIO(text).readline):
                if token.type == tokenize.COMMENT and re.search(r'省略|omitted|implementation omitted', token.string, re.I):
                    add(path, token.start[0], "OMITTED_IMPLEMENTATION", "源码明确标注省略实现", "无法执行等价业务验证", "原作者提供完整实现或明确标记受控替身", layer="UNKNOWN")
        elif lower_path.endswith('.java'):
            # Lexical import evidence is useful, but is deliberately not a Java semantic parser.
            status = "LEXICAL_ONLY"
            cleaned = re.sub(r'/\*[\s\S]*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"', lambda m: '\n' * m.group(0).count('\n'), text)
            for match in re.finditer(r'(?m)^\s*import\s+(?:static\s+)?((?:com\.openjiuwen|io\.agentscope|dev\.langchain4j)\.[\w.*]+)\s*;', cleaned):
                add(path, cleaned[:match.start()].count('\n') + 1, "SDK_IMPORT", "Java 导入运行框架类型", "仅确认导入绑定，未解析完整类型与调用关系", "将框架引用保留在适配区域并用实际 SDK 编译验证", symbol=match.group(1))
            add(path, 1, "UNPARSED_CODE", "Java 仅完成词法导入检查", "方法调用、泛型、反射及依赖版本仍需工程检查", "提供可编译工程与依赖锁；不把词法检查当编译通过", layer="UNKNOWN")
        elif lower_path.endswith(('.js', '.ts', '.tsx', '.jsx', '.sh', '.mjs', '.cjs', '.go', '.rs', '.rb', '.c', '.cpp', '.cs')):
            status = "UNSUPPORTED_LANGUAGE"
            add(path, 1, "UNPARSED_CODE", "本轮未配置此语言的语义解析器", "未发现依赖不能解释为无依赖", "人工审阅或补充对应静态解析器", layer="UNKNOWN")
        if path.lower().endswith('skill.md'):
            for line, content in enumerate(text.splitlines(), 1):
                for match in re.finditer(r'`((?:references?|scripts)/[^`]+)`', content):
                    ref = match.group(1)
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), ref))
                    if resolved not in files:
                        add(path, line, "MISSING_RESOURCE", "方法引用的相对资源不存在：" + ref,
                            "执行时无法读取所声明资源", "核实目录并建立显式资源映射，不静默改写原文", layer="UNKNOWN", symbol=ref)
                if re.search(r'自动注入|自动加载|auto.?inject', content, re.I):
                    add(path, line, "RESOURCE_INJECTION", "方法约定资源由宿主自动注入", "目标 Host 必须显式实现相同资源加载与可见性", "区分模型可见方法与工具专用配置，生成资源声明", layer="HOST")
            if not text.startswith('---\n') and not text.startswith('---\r\n'):
                add(path, 1, "METADATA_FORMAT", "缺少标准 frontmatter 起始分隔符", "元数据解析存在兼容差异", "仅规范化元数据，保留原业务正文", layer="FORMAT")
            if 'long_term' in text and '短期借款' in text:
                line = next(i for i, s in enumerate(text.splitlines(), 1) if 'long_term' in s)
                add(path, line, "BUSINESS_CONFLICT", "长期命名与短期借款描述同时出现", "不能由 SDK 迁移决定业务口径", "由业务 Owner 确认；本轮原样保留", confidence="MEDIUM", layer="BUSINESS")
        coverage.append(dict(path=path, status=status))
    return dict(findings=findings, coverage=coverage, declarations=tools, structure=structure_of(files))


# A file's role, decided by where it is -- never by what it contains. The point is to answer "what
# is this package made of" in one deterministic pass, so that reading it is not a search.
_SEGMENT_ROLES = {"scripts": "SCRIPT", "references": "REFERENCE", "assets": "ASSET"}
_SOURCE_SUFFIXES = (".py", ".js", ".mjs", ".cjs", ".ts", ".java", ".go", ".rb", ".sh", ".ps1")


def _role_of(path):
    name = posixpath.basename(path).lower()
    if name in ("skill.md", "skill.mdx"):
        return "SKILL_DOCUMENT"
    for segment in path.lower().split("/")[:-1]:
        if segment in _SEGMENT_ROLES:
            return _SEGMENT_ROLES[segment]
    return "SOURCE" if name.endswith(_SOURCE_SUFFIXES) else "OTHER"


def structure_of(files):
    """The package's shape: every directory the files imply, and what each file is for.

    Coverage says how far each file was read; it does not say what the package looks like, so an
    agent that wants the layout has to go and list directories. This is that answer, computed
    rather than searched for.

    Only directories that contain files appear: the scanner is handed files, not a filesystem, so
    an empty directory is invisible to it -- and an empty directory is not part of what a migration
    has to account for.
    """
    directories = set()
    entries = []
    for path in sorted(files):
        parent = posixpath.dirname(path)
        while parent:
            directories.add(parent)
            parent = posixpath.dirname(parent)
        # `replace` because this text is untrusted: a caller that hands over a JS string can send a
        # lone surrogate as `\udXXX`, which json accepts and utf-8 cannot encode. A size that is a
        # byte or two off on a malformed file is not worth failing the whole scan over.
        size = len(files[path].encode("utf-8", "replace"))
        entries.append(dict(path=path, role=_role_of(path), bytes=size))
    return dict(directories=sorted(directories), files=entries)


if __name__ == '__main__':
    # This is a UTF-8 JSON subprocess protocol, independent of the Windows code page.
    # -I ignores PYTHONUTF8; decoding the text stream with the host locale can even corrupt
    # JSON delimiters next to Chinese characters in nested dependency declarations.
    data = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    # ASCII-safe on purpose. `ensure_ascii=False` put the findings' Chinese on stdout raw, which
    # made this protocol depend on the *console codepage* of whoever ran it: the callers spawn this
    # with `python -I`, and `-I` implies `-E`, so PYTHONUTF8=1 is ignored and the bytes came out in
    # the local code page. `json.loads` on the caller's side then failed to detect the encoding and
    # reported the whole scan as invalid -- so the agent, which is the caller that most needs the
    # result, was getting `{"status": "unavailable"}` and going off to list directories by hand.
    # Escaped non-ASCII is valid JSON that every parser decodes back to the same characters.
    print(json.dumps(scan(data['files'])))
