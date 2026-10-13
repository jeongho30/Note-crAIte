// OS마다 다른 화면 낱말. 문구는 Windows 기준으로 쓰고, macOS에서 달라지는 낱말만 여기서 가져온다.
export const isMac = navigator.userAgent.includes('Macintosh')

/** "이 PC" 자리 */
export const PC = isMac ? 'Mac' : 'PC'
/** 목적격 조사까지 ("PC를 켜면") */
export const PC_OBJ = isMac ? 'Mac을' : 'PC를'
/** 주격 조사까지 ("PC가 느려질 수 있어요") */
export const PC_SUBJ = isMac ? 'Mac이' : 'PC가'
export const OS = isMac ? 'macOS' : 'Windows'
/** 받아쓰기에 쓰는 그래픽 장치. Apple Silicon은 카드가 아니라 칩 안에 있다 */
export const GPU = isMac ? 'GPU' : '그래픽카드'
/** 창을 닫아도 앱 아이콘이 남는 곳 */
export const TRAY = isMac ? '메뉴 막대' : '트레이'
export const TRAY_WHERE = isMac ? '메뉴 막대(화면 오른쪽 위 아이콘)' : '트레이(작업 표시줄 오른쪽 아이콘)'
export const TRAY_MENU = isMac ? '메뉴 막대 아이콘의 메뉴' : '트레이 메뉴'
/** 데이터 폴더가 있는 곳. core/paths.ts의 defaultDataDir과 같아야 한다 */
export const DATA_DIR = isMac ? '~/Library/Application Support/lecture-notes' : '%LOCALAPPDATA%\\lecture-notes'
/** 마이크 권한이 꺼져 있을 때 켜는 곳 */
export const MIC_SETTINGS_HELP = isMac
  ? '시스템 설정 > 개인정보 보호 및 보안 > 마이크에서 이 앱을 켜 주세요.'
  : 'Windows 설정 > 개인 정보 > 마이크에서 "데스크톱 앱이 마이크에 액세스하도록 허용"을 켜 주세요.'
