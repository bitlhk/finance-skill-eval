param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
# Enumerate physical entries exactly once: pnpm contains cyclic junction graphs.
# GetChildItem/icacls recursive traversal through those links can revisit packages.
if (-not ('FinanceDeploymentAcl' -as [type])) {
    $FileSetter = 'System.IO.File.SetAccessControl(file.FullName, acl);'
    $DirectorySetter = 'System.IO.Directory.SetAccessControl(directory.FullName, acl);'
    $FileGetter = 'System.IO.File.GetAccessControl(file.FullName)'
    $DirectoryGetter = 'System.IO.Directory.GetAccessControl(directory.FullName)'
    if ($PSVersionTable.PSEdition -eq 'Core') {
        $FileSetter = 'System.IO.FileSystemAclExtensions.SetAccessControl(file, acl);'
        $DirectorySetter = 'System.IO.FileSystemAclExtensions.SetAccessControl(directory, acl);'
        $FileGetter = 'System.IO.FileSystemAclExtensions.GetAccessControl(file)'
        $DirectoryGetter = 'System.IO.FileSystemAclExtensions.GetAccessControl(directory)'
    }
    Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Security.AccessControl;
public static class FinanceDeploymentAcl {
    public static long Reset(string path) {
        long count = 0;
        foreach (FileSystemInfo entry in new DirectoryInfo(path).GetFileSystemInfos()) {
            if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) {
                var start = new System.Diagnostics.ProcessStartInfo("icacls.exe", "\"" + entry.FullName + "\" /reset /L /Q");
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardOutput = true;
                using (var process = System.Diagnostics.Process.Start(start)) {
                    process.StandardOutput.ReadToEnd();
                    process.WaitForExit();
                    if (process.ExitCode != 0) throw new IOException("Link ACL reset failed.");
                }
                count++;
                continue;
            }
            if (entry is DirectoryInfo) {
                var directory = (DirectoryInfo)entry;
                var existing = $DirectoryGetter;
                if (existing.AreAccessRulesProtected || existing.GetAccessRules(true, false, typeof(System.Security.Principal.SecurityIdentifier)).Count != 0) {
                    var acl = new DirectorySecurity();
                    acl.SetAccessRuleProtection(false, false);
                    $DirectorySetter
                }
                count += Reset(directory.FullName);
            } else {
                var file = (FileInfo)entry;
                var existing = $FileGetter;
                if (existing.AreAccessRulesProtected || existing.GetAccessRules(true, false, typeof(System.Security.Principal.SecurityIdentifier)).Count != 0) {
                    var acl = new FileSecurity();
                    acl.SetAccessRuleProtection(false, false);
                    $FileSetter
                }
            }
            count++;
        }
        return count;
    }
}
"@
}
Write-Output ("Physical ACL entries verified/reset: " + [FinanceDeploymentAcl]::Reset($Directory))
