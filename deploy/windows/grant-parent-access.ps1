param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
# Ancestor access must not traverse sibling checkouts or propagate their ACLs.
# SetFileSecurity applies only to the named object, unlike SetNamedSecurityInfo:
# https://learn.microsoft.com/windows/win32/secauthz/automatic-propagation-of-inheritable-aces
if (-not ('FinanceParentAcl' -as [type])) {
    Add-Type @'
using System.Runtime.InteropServices;
public static class FinanceParentAcl {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetFileSecurity(string name, uint info, byte[] descriptor);
}
'@
}
$Sid = New-Object Security.Principal.SecurityIdentifier('S-1-5-19')
$Parent = [IO.Directory]::GetParent([IO.Path]::GetFullPath($Directory))
while ($Parent) {
    $Acl = Get-Acl -LiteralPath $Parent.FullName
    $Rule = New-Object Security.AccessControl.FileSystemAccessRule($Sid, 'ReadAndExecute', 'None', 'None', 'Allow')
    $Acl.AddAccessRule($Rule)
    if (-not [FinanceParentAcl]::SetFileSecurity($Parent.FullName, 4, $Acl.GetSecurityDescriptorBinaryForm())) {
        throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
    }
    $Parent = $Parent.Parent
}
