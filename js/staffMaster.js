// 職員マスタ
// isAutoTarget: false の職員はシフト自動割当の対象外（栄養士・調理師等）
const STAFF_MASTER = [
  { id: 1,  type: "fulltime_nursery", isFixed: false, isAutoTarget: true,  adjuster: null,          adjusterPriority: null, fairness: true,  satEarlyRequired: true  },
  { id: 2,  type: "fulltime_nursery", isFixed: false, isAutoTarget: true,  adjuster: null,          adjusterPriority: null, fairness: true,  satEarlyRequired: true  },
  { id: 3,  type: "fulltime_nursery", isFixed: true,  isAutoTarget: true,  adjuster: null,          adjusterPriority: null, fairness: false, satEarlyRequired: false },
  { id: 4,  type: "part_nursery",     isFixed: false, isAutoTarget: true,  adjuster: null,          adjusterPriority: null, fairness: false, satEarlyRequired: false },
  { id: 5,  type: "other",            isFixed: false, isAutoTarget: false, adjuster: null,          adjusterPriority: null, fairness: false, satEarlyRequired: false },
  { id: 6,  type: "nurse",            isFixed: false, isAutoTarget: true,  adjuster: null,          adjusterPriority: null, fairness: true,  satEarlyRequired: true  },
  { id: 7,  type: "nurse",            isFixed: false, isAutoTarget: true,  adjuster: null,          adjusterPriority: null, fairness: true,  satEarlyRequired: true  },
  { id: 8,  type: "other",            isFixed: false, isAutoTarget: false, adjuster: null,          adjusterPriority: null, fairness: false, satEarlyRequired: false },
  { id: 9,  type: "clerk",            isFixed: false, isAutoTarget: true,  adjuster: "early",       adjusterPriority: 1,    fairness: false, satEarlyRequired: false },
  { id: 10, type: "other",            isFixed: false, isAutoTarget: false, adjuster: null,          adjusterPriority: null, fairness: false, satEarlyRequired: false },
  { id: 11, type: "other",            isFixed: false, isAutoTarget: false, adjuster: null,          adjusterPriority: null, fairness: false, satEarlyRequired: false },
  { id: 12, type: "other",            isFixed: false, isAutoTarget: false, adjuster: null,          adjusterPriority: null, fairness: false, satEarlyRequired: false },
  { id: 13, type: "other",            isFixed: false, isAutoTarget: false, adjuster: null,          adjusterPriority: null, fairness: false, satEarlyRequired: false },
  { id: 14, type: "other",            isFixed: false, isAutoTarget: false, adjuster: null,          adjusterPriority: null, fairness: false, satEarlyRequired: false },
  { id: 15, type: "director",         isFixed: false, isAutoTarget: true,  adjuster: "both",        adjusterPriority: 2,    fairness: false, satEarlyRequired: false },
];
// 15番: early adjusterPriority=2、late adjusterPriority=1（唯一の遅出調整弁）
// 早出調整弁：9番(priority1)→15番(priority2)
// 遅出調整弁：15番のみ(priority1)
