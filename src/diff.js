// ===========================================================
//  2단계 — 파싱한 공지 목록에서 "새 글" 만 골라낸다
//
//  크론 본체에서 떼어내 순수 함수로 만들었다.
//    - 인터넷도 KV 도 건드리지 않으니 테스트가 쉽다
//    - 7단계 크론 코드가 훨씬 단순해진다
//
//  새 글 판정이 왜 이렇게 간단한가:
//    게시판 글 번호(no)가 단조 증가한다. 새 글일수록 번호가 크다.
//    그래서 "마지막으로 알린 번호보다 크면 새 글" 이면 끝이다.
//    본문 해시를 뜨거나 날짜를 비교할 필요가 없다.
// ===========================================================

/**
 * @param {Array<{no:number}>} items  parse() 결과
 * @param {number} lastNo             마지막으로 알린 글 번호 (처음이면 0)
 * @returns {{ fresh: Array, maxNo: number }}
 *          fresh — 알림을 보낼 새 글 (오래된 것부터)
 *          maxNo — KV 에 저장할 새 lastNo
 */
export function diff(items, lastNo) {
  // 게시판이 비었거나 파싱이 실패한 경우. lastNo 를 건드리지 않는다.
  if (items.length === 0) return { fresh: [], maxNo: lastNo };

  const maxNo = Math.max(...items.map((c) => c.no));

  // 첫 실행(lastNo 가 0)에는 알림을 보내지 않는다.
  // 안 그러면 게시판에 있는 25건이 한꺼번에 폰으로 쏟아진다.
  // 대신 maxNo 만 기록해두고, 다음 실행부터 진짜 새 글만 잡는다.
  if (!lastNo) return { fresh: [], maxNo };

  const fresh = items
    .filter((c) => c.no > lastNo)
    .sort((a, b) => a.no - b.no); // 오래된 글부터 알림이 가도록 오름차순

  return { fresh, maxNo };
}
