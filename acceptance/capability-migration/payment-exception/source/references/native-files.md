# 宿主文件合同

read_file 与 list_files 均接受必填字符串 path 和可选 scope（workspace 或 skill），禁止其他参数。默认 workspace 为本次任务独立工作区，skill 为安装的 Skill 文档目录。权限 workspace.read、skill.read，副作用 read，隔离 per_case_workspace。

read_file 成功返回 {path,content}，读取 UTF-8 文件，拒绝绝对路径、父目录穿越、越界、非文件和超过 256 KiB 的文件。读取、解码或输出大小失败返回 {status:"unavailable",error:"TOOL_EXECUTION_FAILED"}。

list_files 对相对目录列举直接普通文件，path="." 表示根目录。成功返回 {path,files:string[]}，files 按字典序排序，相对于所选 scope，可直接传给 read_file。拒绝绝对路径、父目录穿越、符号链接、超过 256 个目录项的目录。不递归、不读文件内容。失败返回 {status:"unavailable",error:"TOOL_EXECUTION_FAILED"}。

两者不持久化也不能读取其他任务工作区，不代表为其他可执行代码提供操作系统沙箱。
