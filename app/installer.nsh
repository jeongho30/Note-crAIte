; 제거할 때 하는 일. 새 판을 덮어 설치할 때(--updated)는 아무것도 하지 않는다.
; - 앱이 첫 실행 마법사에서 만든 바탕화면 바로가기를 지운다.
; - 데이터 폴더가 있으면 함께 지울지 묻는다: 전부(모델·녹음·작업 기록·설정·API 키), 아니면 받은 모델만.
;   조용한 제거(/S)에서는 묻지 않고 그대로 둔다.
; 데이터 폴더 이름은 src/core/paths.ts의 APP_NAME이고, Electron이 %APPDATA%에 쓰는 폴더(캐시, API 키를 푸는 열쇠)도 같은 이름이다.
!define DATA_DIR "$LOCALAPPDATA\lecture-notes"

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Delete "$DESKTOP\Note-crAIte.lnk"

    ; 한 번 클릭 제거는 확인 창 뒤에 스스로 조용한 모드로 바뀌므로 ${Silent}가 아니라 /S를 직접 본다.
    ; 조용한 모드에서도 /SD가 없는 MessageBox는 뜬다.
    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "/S" $R1
    ${if} ${Errors}
    ${andIf} ${FileExists} "${DATA_DIR}\*.*"
      ${if} ${Cmd} `MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "앱 데이터도 모두 지울까요?$\r$\n$\r$\n받은 받아쓰기 모델, 앱에서 한 녹음, 작업 기록, 설정, API 키가 지워지고 되돌릴 수 없어요.$\r$\n만든 노트는 그대로 남아요." IDYES`
        RMDir /r "${DATA_DIR}"
        RMDir /r "$APPDATA\lecture-notes"
      ${elseIf} ${FileExists} "${DATA_DIR}\models\*.*"
      ${andIf} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "받은 받아쓰기 모델만 지울까요?$\r$\n$\r$\n다시 설치하면 모델을 다시 받아야 해요." IDYES`
        RMDir /r "${DATA_DIR}\models"
      ${endIf}
    ${endIf}
  ${endIf}
!macroend
