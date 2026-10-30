; electron-builder 会自动引入 buildResources 下的 installer.nsh，这里只挂官方提供的自定义宏

; 选完安装目录后检测能否写入。「仅为我安装」时安装器不提权，选到没有写入权限的目录（如 Program Files）
; 会在复制文件时误报「Deva 无法关闭」，重试后又报写入卸载程序失败，忽略下去只留下指向空目录的快捷方式。
; 这里在开始安装前拦下：可写则直接跳过本页；不可写就说明原因，让用户返回更换目录或改为所有用户安装
!macro customPageAfterChangeDir
  !include nsDialogs.nsh

  Var dirCheckTarget
  Var dirCheckWritable

  Page custom dirCheckPageCreate dirCheckPageLeave

  ; 插入本页后，NSIS 不再把目录页的按钮显示为「安装」而是「下一步」，可写时本页又被跳过，点下去就直接装了。
  ; .onVerifyInstDir 只在目录页加载和路径改动时触发，借它把按钮文字改回「安装」
  Function .onVerifyInstDir
    Push $0
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^InstallBtn)"
    Pop $0
  FunctionEnd

  ; 结果写入 $dirCheckWritable（1 可写 / 0 不可写），目标目录写入 $dirCheckTarget
  Function dirCheckRun
    Push $0
    Push $1
    Push $2

    StrCpy $dirCheckTarget $INSTDIR
    !ifdef allowToChangeInstallationDirectory
      ; 与模板里的 instFilesPre 一致：路径不含应用名时，实际装到其下的应用名子目录
      ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
      ${if} $0 == ""
        StrCpy $dirCheckTarget "$INSTDIR\${APP_FILENAME}"
      ${endif}
    !endif

    ; 记下最近一个已存在的上级目录：检测时可能连建多级目录，检测完要把新建的空目录逐级删掉，
    ; 免得用户返回换目录后留下垃圾
    StrCpy $1 $dirCheckTarget
    ${Do}
      ${If} $1 == ""
      ${OrIf} ${FileExists} "$1\*.*"
        ${ExitDo}
      ${EndIf}
      ${GetParent} $1 $1
    ${Loop}

    StrCpy $dirCheckWritable 0
    ClearErrors
    CreateDirectory "$dirCheckTarget"
    FileOpen $2 "$dirCheckTarget\.deva-write-test" w
    ${IfNot} ${Errors}
      FileClose $2
      Delete "$dirCheckTarget\.deva-write-test"
      StrCpy $dirCheckWritable 1
    ${EndIf}

    ; RMDir 不带 /r 只删空目录，安装目录里原有的文件不会被动到
    StrCpy $0 $dirCheckTarget
    ${Do}
      ${If} $0 == $1
      ${OrIf} $0 == ""
        ${ExitDo}
      ${EndIf}
      RMDir "$0"
      ${GetParent} $0 $0
    ${Loop}

    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; 提示文字按界面语言在运行时选：installer 默认加载几十种语言，LangString 缺任何一种都会因 -WX 构建失败
  Function dirCheckMessage
    ${if} $LANGUAGE == 2052
      Push "当前账户没有以下目录的写入权限：$\r$\n$\r$\n$dirCheckTarget$\r$\n$\r$\n请点击「上一步」更换安装目录。如需安装到该目录，请返回安装选项页选择「为使用这台电脑的任何人安装」，或右键安装包选择「以管理员身份运行」。"
    ${elseif} $LANGUAGE == 1028
      Push "目前帳戶沒有以下目錄的寫入權限：$\r$\n$\r$\n$dirCheckTarget$\r$\n$\r$\n請點擊「上一步」更換安裝目錄。如需安裝到該目錄，請返回安裝選項頁選擇「為使用這台電腦的任何人安裝」，或右鍵安裝程式選擇「以系統管理員身分執行」。"
    ${else}
      Push "The current account cannot write to this folder:$\r$\n$\r$\n$dirCheckTarget$\r$\n$\r$\nClick Back to choose another folder. To install here, go back to the installation options and choose $\"Anyone who uses this computer$\", or right-click the installer and choose $\"Run as administrator$\"."
    ${endif}
  FunctionEnd

  Function dirCheckPageCreate
    ; 自动更新沿用原安装目录，不做拦截
    ${if} ${isUpdated}
      Abort
    ${endif}

    Call dirCheckRun
    ${if} $dirCheckWritable == 1
      Abort
    ${endif}

    ${if} $LANGUAGE == 2052
      !insertmacro MUI_HEADER_TEXT "无法写入安装目录" "请更换安装目录，或以管理员权限安装。"
    ${elseif} $LANGUAGE == 1028
      !insertmacro MUI_HEADER_TEXT "無法寫入安裝目錄" "請更換安裝目錄，或以系統管理員權限安裝。"
    ${else}
      !insertmacro MUI_HEADER_TEXT "Cannot write to the installation folder" "Choose another folder, or install with administrator rights."
    ${endif}

    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endif}

    Call dirCheckMessage
    Pop $1
    ${NSD_CreateLabel} 0 0 100% 100% "$1"
    Pop $0

    ; 本页只能「上一步」或「取消」：禁用「安装」按钮（禁用后回车键也不会触发它）
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 0
    ${NSD_OnBack} dirCheckPageBack

    nsDialogs::Show
  FunctionEnd

  ; 返回目录页时重新启用「安装」按钮，否则它会一直保持禁用
  Function dirCheckPageBack
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 1
  FunctionEnd

  ; 兜底：按钮已禁用，正常走不到这里；万一进入了，仍不可写就留在本页
  Function dirCheckPageLeave
    Call dirCheckRun
    ${if} $dirCheckWritable == 0
      Call dirCheckMessage
      Pop $1
      MessageBox MB_OK|MB_ICONEXCLAMATION "$1"
      Abort
    ${endif}
  FunctionEnd
!macroend
