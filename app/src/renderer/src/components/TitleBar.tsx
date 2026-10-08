import { PRODUCT_NAME } from '../../../core/brand'
import icon from '../assets/icon.png'
import { isMac } from '../platform'
import styles from './TitleBar.module.css'

/**
 * 창 맨 위의 띠. 기본 제목 줄 대신 앱 색으로 그리고, 끌어서 창을 옮긴다.
 * 최소화·닫기 버튼은 Windows가 오른쪽 위에, macOS가 왼쪽 위에 겹쳐 그린다.
 * macOS는 띠를 비워 둔다: Apple 지침이 앱 이름을 창 제목으로 쓰지 말라고 하고, 창이 하나라 제목이 필요 없다
 */
export function TitleBar(): React.JSX.Element {
  return (
    <header className={styles.bar}>
      {!isMac && (
        <>
          <img className={styles.icon} src={icon} alt="" />
          <span>{PRODUCT_NAME}</span>
        </>
      )}
    </header>
  )
}
