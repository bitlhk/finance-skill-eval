# 宿主文件能力

两项工具输入都是 JSON 对象：必填 `path: string`，可选 `scope: "workspace" | "skill"`，禁止其他参数。默认 workspace 是本次任务独立工作区；skill 是安装的 Skill 文档所在目录。权限仅 workspace.read、skill.read，副作用为只读，隔离为 per_case_workspace。

`read_file` 读取相对路径的 UTF-8 文件，成功返回 `{path, content}`；拒绝绝对路径、越界、父目录穿越、非文件与超过 256 KiB 的文件。路径、读取、解码或输出大小失败返回 `{status:"unavailable",error:"TOOL_EXECUTION_FAILED"}`。不持久化或读取其他任务的工作区。

`list_files` 列举相对目录的直接普通文件，根目录用 `path:"."`。成功返回 `{path, files:string[]}`，路径按字典序排序，均相对于所选 scope，可直接传给 read_file。不递归、不返回内容。拒绝绝对路径、父目录穿越、符号链接，以及超过 256 个目录项的目录；失败返回 `{status:"unavailable",error:"TOOL_EXECUTION_FAILED"}`。不持久化或读取其他任务的工作区。

这些工具边界并不代表为其他业务代码提供了操作系统沙箱。
