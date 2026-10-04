; 앱이 첫 실행 마법사에서 만든 바탕화면 바로가기를 제거할 때 지운다 (다시 설치할 때는 둔다)
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Delete "$DESKTOP\Note-crAIte.lnk"
  ${endIf}
!macroend
