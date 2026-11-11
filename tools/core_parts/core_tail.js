
  // ════════════════════════════════════════════════
  // PUBLIC API — dipakai oleh widget Qt
  // ════════════════════════════════════════════════
  return {
    start, resize, renderNow, render, loadData,
    toggleIndicator, toggleTool, deleteSelected, gotoLatestBtn,
    setBubbleMinToken, setBubbleMultiplier, setHvn, setCvdExchanges, setGamma, gammaSupported, setLiq, liqClear, setHa,
    setChartType, setRenko, setFp, isIndicatorBlocked: ctIsBlocked, indicatorBlockedTag: ctBlockedTag,
    stopMomentum, fmtP,
    TF_LBL, ALL_CVD_EXCHANGES,
    get indicators() { return indicators; },
    get bubbleConfig() { return bubbleConfig; },
    get hvnConfig() { return hvnConfig; },
    get gammaConfig() { return gammaConfig; },
    get liqConfig() { return liqConfig; },
    get haConfig() { return haConfig; },
    get haDefaults() { return HA_DEFAULTS; },
    get chartType() { return chartType; },
    get chartTypeLabel() { return CT_LABEL[chartType]; },
    get chartTypeShort() { return CT_SHORT[chartType]; },
    get chartTypes() { return CT_IDS.map(id => ({ id, label: CT_LABEL[id], short: CT_SHORT[id] })); },
    get renkoConfig() { return renkoConfig; },
    get renkoDefaults() { return RK_DEFAULTS; },
    get renkoBrickSize() { return chartType === 'renko' ? renkoSize() : 0; },
    get fpConfig() { return fpConfig; },
    get fpDefaults() { return FP_DEFAULTS; },
    get fp() { return { ready: fpReady, base: fpBase, candles: fpData.size }; },
    get liq() { return { tex: liqTex, cand: liqCand }; },
    get gamma() { return { data: gammaData, status: gammaStatus, msg: gammaMsg, base: gammaCurBase }; },
    get cvdConfig() { return cvdConfig; },
    get sym() { return sym; },
    get tf() { return tf; },
    get loading() { return loading; },
    get hasBars() { return bars.length > 0; },
    get activeTool() { return DM.activeTool; },
    get cam() { return { leftBar, barW, nBars: bars.length, drawings: DM.drawings.length }; },
    get hvn() { return { zones: hvnZones, periods: hvnPeriods, live: hvnLive, tick: hvnTick, dirty: hvnDirty }; },
    get bars() { return bars; },
    hvnAnchorStart, HVN_ANCHOR_SEC
  };
};
