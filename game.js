(function () {
  'use strict';

  var isWX = typeof wx !== 'undefined' && typeof wx.createCanvas === 'function';
  var canvas = isWX ? wx.createCanvas() : document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var W = 390, H = 844, dpr = 1, screenW = 390, screenH = 844;
  var mode = 'title', elapsed = 0, lastFrame = 0;
  var settlementTimer = 0, settlementResult = 'over';
  var showInputDiagnostics = false, devPointerFallback = false;
  var inputDiagnostics = { starts:0, ends:0, pointer:0, accepted:0, shots:0, lastTouchAt:-1, lastAcceptedAt:-1, lastShotAt:-1 };
  var giants = [], shells = [], blasts = [], sparks = [], bloodMists = [], scenery = [];
  var spawnTimer = 0, spawnOrder = [], spawnIndex = 0, cannons = [], soldiers = [true,true,true], targetQueue = [], shotGap = 0, aimMark = null;
  var lastTap = -Infinity, tapInterval = 0.18;
  var shake = 0, damageFlash = 0, uid = 0;
  var lastVibrationAt = -Infinity;
  var countdown = 0, pausedFrom = 'playing', settingsReturn = 'title', draggingVolume = null;
  var settings = { volume: 0.7, music: 0.75, sfxMuted: false, musicMuted: false, vibration: true, difficulty: 'normal' }, soundPools = {}, soundIndex = {};
  var musicPlayer = null, musicTrack = null, battleFirstShot = false;
  var DIFFICULTIES = {
    easy: { label: '轻松', description: '怪物较慢，炮击范围更大', speed: 0.82, intervalMin: 0.95, intervalMax: 1.24, floor: 0.78, ramp: 0.00055, blastScale: 1.2, aimAssist: 1.2, cannonCooldown: 0.22, shotMin: 0.06, shotMax: 0.12 },
    normal: { label: '标准', description: '怪物来袭更紧，注意炮击落点', speed: 1.2, intervalMin: 0.57, intervalMax: 0.78, floor: 0.46, ramp: 0.00083, blastScale: 0.86, aimAssist: 1, cannonCooldown: 0.24, shotMin: 0.075, shotMax: 0.14 },
    hard: { label: '挑战', description: '来袭更快更密，需要精准炮击', speed: 1.36, intervalMin: 0.51, intervalMax: 0.67, floor: 0.4, ramp: 0.0009, blastScale: 0.76, aimAssist: 0.85, nearWallAssist: 1.08, arrivalGap: 0.23, cannonCooldown: 0.26, shotMin: 0.09, shotMax: 0.16, bossSpeedFactor: 1.5 }
  };
  var roundDifficulty = DIFFICULTIES.normal;
  var RESULT_RETRY_Y = 62, RESULT_HOME_Y = 125;
  var art = { crew: null, battlefield: null, wall: null,
    giant0: null, giant1: null, giant2: null, giant3: null, giant4: null, giant5: null };
  var artLoadError = false;

  try {
    var savedSettings=isWX?wx.getStorageSync('wallDefenseSettings'):localStorage.getItem('wallDefenseSettings');
    if(savedSettings){
      if(typeof savedSettings==='string') savedSettings=JSON.parse(savedSettings);
      if(savedSettings.volume!==undefined) settings.volume=clamp(Number(savedSettings.volume),0,1);
      if(!isFinite(settings.volume)) settings.volume=.7;
      if(savedSettings.music!==undefined) settings.music=clamp(Number(savedSettings.music),0,1);
      if(!isFinite(settings.music)) settings.music=.75;
      if(savedSettings.audioVersion!==1) {
        if(settings.volume===.65) settings.volume=.7;
        if(settings.music===.38) settings.music=.75;
      }
      settings.sfxMuted=savedSettings.sfxMuted===true;
      settings.musicMuted=savedSettings.musicMuted===true;
      settings.vibration=savedSettings.vibration!==false;
      if(DIFFICULTIES[savedSettings.difficulty]) settings.difficulty=savedSettings.difficulty;
    }
  } catch(e) { /* Default settings remain available. */ }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function saveSettings() {
    try {
      settings.audioVersion=1;
      if(isWX) wx.setStorageSync('wallDefenseSettings',settings);
      else localStorage.setItem('wallDefenseSettings',JSON.stringify(settings));
    } catch(e) { /* Settings still work for this session. */ }
  }
  function prepareSoundPool(name) {
    var src={ui:'assets/ui.wav',shot:'assets/shot.wav',impact:'assets/impact.wav'}[name];
    if(!src||soundPools[name]) return;
    if(!soundPools[name]) {
      soundPools[name]=[];soundIndex[name]=0;
      var count=name==='ui'?1:(name==='impact'?2:3);
      for(var a=0;a<count;a++) {
        var player=isWX?wx.createInnerAudioContext():(typeof Audio!=='undefined'?new Audio():null);
        if(!player) break;
        player.src=src;soundPools[name].push(player);
      }
    }
  }
  function playSound(name) {
    if(settings.sfxMuted||settings.volume<=0) return;
    prepareSoundPool(name);
    if(!soundPools[name])return;
    var pool=soundPools[name];if(!pool.length)return;
    var playIndex=soundIndex[name]++,audio=pool[playIndex%pool.length];
    try {
      var mixGain={ui:0.45,shot:0.65,impact:0.7}[name];
      audio.volume=settings.volume*mixGain;
      if(playIndex>=pool.length) {
        if(isWX) audio.stop(); else {audio.pause();audio.currentTime=0;}
      }
      var result=audio.play();if(result&&result.catch)result.catch(function(){});
    } catch(e) { /* Sound can fail if the device is muted. */ }
  }
  function stopMusic() {
    if(!musicPlayer)return;
    try {
      if(isWX) musicPlayer.stop();
      else {musicPlayer.pause();musicPlayer.currentTime=0;}
    } catch(e) { /* Audio may not have started. */ }
    musicTrack=null;
  }
  function musicVolume() {
    if(settings.musicMuted)return 0;
    var gain=isWX&&musicTrack==='battle'&&!battleFirstShot?0.5:0.65;
    return settings.music*gain;
  }
  function playMusic(track) {
    var src={title:'assets/music-homepage.mp3',battle:'assets/music-battle.mp3',win:'assets/music-victory.mp3',lose:'assets/music-failure.mp3'}[track];
    if(!src)return;
    if(!musicPlayer)musicPlayer=isWX?wx.createInnerAudioContext():(typeof Audio!=='undefined'?new Audio():null);
    if(!musicPlayer)return;
    stopMusic();
    musicTrack=track;
    try {
      musicPlayer.src=src;musicPlayer.loop=track==='battle'||track==='title';
      musicPlayer.volume=musicVolume();
      var result=musicPlayer.play();if(result&&result.catch)result.catch(function(){});
    } catch(e) { /* Device audio may be unavailable. */ }
  }
  function pauseMusic() {
    if(musicPlayer&&musicTrack)try{musicPlayer.pause();}catch(e){}
  }
  function resumeMusic() {
    if(!musicPlayer||!musicTrack)return;
    try {
      musicPlayer.volume=musicVolume();
      var result=musicPlayer.play();if(result&&result.catch)result.catch(function(){});
    } catch(e) { /* Device audio may be unavailable. */ }
  }
  function updateMusicVolume() {
    if(musicPlayer)try{musicPlayer.volume=musicVolume();}catch(e){}
  }
  function vibrate(force) {
    if(settings.vibration&&isWX&&wx.vibrateShort) {
      var now=Date.now();
      if(!force&&now-lastVibrationAt<500)return;
      lastVibrationAt=now;
      try {wx.vibrateShort({type:'light'});} catch(e) { /* Optional feedback. */ }
    }
  }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function wallFootY() { return wallY(); }
  function wallY() { return H * 0.875; }
  function hudTop() { return Math.max(100,H*.12); }
  function resultOverlayY() { return H*.5-45; }
  function homeControlsY() { return wallY()-255; }
  function soldierX(i) { return W * [0.19,0.5,0.81][i]; }
  function setupCannons() {
    cannons = [{x:W*.19,cooldown:0,recoil:0,crew:0},{x:W*.5,cooldown:0,recoil:0,crew:1},{x:W*.81,cooldown:0,recoil:0,crew:2}];
  }
  function loadArt(name, path) {
    var image = isWX ? wx.createImage() : new Image();
    image.onload = function () { art[name] = image; };
    image.onerror = function () { art[name] = null; artLoadError = true; };
    image.src = path;
  }
  function allArtReady() {
    return !!(art.crew&&art.battlefield&&art.wall&&art.giant0&&art.giant1&&art.giant3&&art.giant4);
  }
  function loadArtPack(name, images) {
    function loadImages() {
      for(var i=0;i<images.length;i++)loadArt(images[i][0],images[i][1]);
    }
    if(!isWX||!wx.loadSubpackage){loadImages();return;}
    try {
      wx.loadSubpackage({name:name,success:loadImages,fail:function(error){
        artLoadError=true;
        if(typeof console!=='undefined')console.error('素材分包加载失败：'+name,error);
      }});
    } catch(error) {
      artLoadError=true;
      if(typeof console!=='undefined')console.error('素材分包加载失败：'+name,error);
    }
  }
  function loadGameArt() {
    artLoadError=false;
    loadArtPack('field',[['battlefield','packs/field/battlefield-no-houses.png']]);
    loadArtPack('wall',[['wall','packs/wall/wall-unified.png']]);
    loadArtPack('giants-a',[
      ['giant0','packs/giants-a/giant-muscle.png'],
      ['giant1','packs/giants-a/giant-lanky.png']
    ]);
    loadArtPack('giants-b',[
      ['giant3','packs/giants-b/giant-natural-grin.png'],
      ['giant4','packs/giants-b/giant-wideeyes.png']
    ]);
  }
  function rounded(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function poly(a, fill, stroke, lw) {
    ctx.beginPath(); ctx.moveTo(a[0], a[1]);
    for (var i = 2; i < a.length; i += 2) ctx.lineTo(a[i], a[i + 1]);
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  }
  function label(s, x, y, size, color, align, weight) {
    ctx.fillStyle = color; ctx.font = (weight || 'bold') + ' ' + size + 'px sans-serif';
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle'; ctx.fillText(s, x, y);
  }

  function makeScenery() {
    scenery = [];
    var seed = 64177;
    function fixedRand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    for (var i = 0; i < 175; i++) {
      var depth = fixedRand();
      scenery.push({ x: fixedRand() * W, y: H * (0.17 + depth * 0.52),
        kind: Math.floor(fixedRand() * 10), s: 0.38 + depth * 1.16, turn: fixedRand() * 6.283 });
    }
    scenery.sort(function (a, b) { return a.y - b.y; });
  }
  function resize() {
    var sw, sh;
    if (isWX) {
      var info = wx.getSystemInfoSync();
      sw = info.screenWidth; sh = info.screenHeight; dpr = info.pixelRatio || 1;
      showInputDiagnostics=info.platform==='devtools';
    } else { sw = canvas.clientWidth || window.innerWidth; sh = canvas.clientHeight || window.innerHeight; dpr = window.devicePixelRatio || 1; }
    screenW=sw;screenH=sh;
    W = 390; H = 390 * sh / sw;
    canvas.width = Math.round(sw * dpr); canvas.height = Math.round(sh * dpr);
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    makeScenery();
  }

  function startGame() {
    if(isWX&&wx.loadSubpackage&&!allArtReady()){
      if(artLoadError)loadGameArt();
      return;
    }
    mode = 'countdown'; countdown = 3; elapsed = 0; spawnTimer = 0.35;
    settlementTimer=0;
    battleFirstShot=false;
    pausedFrom = 'playing';
    roundDifficulty = DIFFICULTIES[settings.difficulty];
    playMusic('battle');
    giants = []; shells = []; blasts = []; sparks = []; bloodMists = []; targetQueue = []; shotGap = 0; aimMark = null;
    spawnOrder = [];
    for (var roundKind=0;roundKind<16;roundKind++) spawnOrder.push(1,3,4);
    spawnOrder.push(4);
    for (var shuffleIndex=spawnOrder.length-1;shuffleIndex>0;shuffleIndex--) {
      var swapIndex=Math.floor(Math.random()*(shuffleIndex+1));
      var tempKind=spawnOrder[shuffleIndex];spawnOrder[shuffleIndex]=spawnOrder[swapIndex];spawnOrder[swapIndex]=tempKind;
    }
    spawnOrder.push(0); spawnIndex=0;
    lastTap = -Infinity; tapInterval = 0.18;
    inputDiagnostics={ starts:0, ends:0, pointer:0, accepted:0, shots:0, lastTouchAt:-1, lastAcceptedAt:-1, lastShotAt:-1 };
    soldiers = [true,true,true]; setupCannons();
    shake = 0; damageFlash = 0;
  }
  function endGame(x, won) {
    if (mode === 'settling' || mode === 'win' || mode === 'over') return;
    if(showInputDiagnostics)console.log('城墙防线触摸诊断',{
      elapsed:Math.round(elapsed*10)/10, starts:inputDiagnostics.starts, ends:inputDiagnostics.ends,
      pointer:inputDiagnostics.pointer, pointerFallback:devPointerFallback,
      accepted:inputDiagnostics.accepted, shots:inputDiagnostics.shots, queued:targetQueue.length,
      lastTouchAt:inputDiagnostics.lastTouchAt,
      lastAcceptedAt:inputDiagnostics.lastAcceptedAt, lastShotAt:inputDiagnostics.lastShotAt
    });
    mode = 'settling'; settlementResult=won?'win':'over'; settlementTimer=1.5;
    targetQueue = []; shake = won ? 0 : 9; damageFlash = won ? 0 : 1;
    if(!won)vibrate(true);
    if(!won)explode(x, wallY() - 8, 50, false);
  }
  function spawnGiant() {
    if (spawnIndex>=spawnOrder.length) return;
    var kind=spawnOrder[spawnIndex++];
    var durability=[3,2,1,1,1,1];
    var baseSpeed=(rand(0.125,0.16)*0.53+Math.min(elapsed*0.0003,0.008))*1.2;
    var speedFactor=kind===0?(roundDifficulty.bossSpeedFactor||1.7):((kind===3||kind===4)?1.4:1);
    var speed=baseSpeed*speedFactor*roundDifficulty.speed, spawnP=-0.15;
    if(roundDifficulty.arrivalGap) {
      var gap=roundDifficulty.arrivalGap, arrival=(1-spawnP)/speed, arrivals=[];
      for(var existing=0;existing<giants.length;existing++)
        if(!giants[existing].state&&giants[existing].speed>0)
          arrivals.push((1-giants[existing].p)/giants[existing].speed);
      arrivals.sort(function(a,b){return a-b;});
      for(var a=0;a<arrivals.length;a++)
        if(arrival>=arrivals[a]-gap&&arrival<arrivals[a]+gap)arrival=arrivals[a]+gap;
      spawnP-=speed*Math.min(0.8,arrival-(1.15/speed));
    }
    giants.push({ id: ++uid, x: rand(23, W - 23), p: spawnP,
      speed: speed,
      hp: durability[kind],
      phase: rand(0, 6.283), kind: kind, wobble: rand(2.5, 5.5) });
  }
  function giantPosAt(g, progress, time) {
    var p = clamp(progress, 0, 1);
    var x = g.x + Math.sin(time * 7.5 + g.phase) * g.wobble * p;
    var y = H * 0.15 + p * (wallFootY() - H * 0.15 - 5);
    return { x:x, y:y, s:(0.075+p*0.42)*[2,1.08,.85,1.12,.95,1.03][g.kind] };
  }
  function giantPos(g) { return giantPosAt(g,g.p,elapsed); }
  function blastRadius(y) { return (48+14*(y/H))*roundDifficulty.blastScale; }
  function aimedGiant(x,y) {
    var chosen=null,best=Infinity;
    for(var i=0;i<giants.length;i++) {
      var giant=giants[i];
      if(giant.state||giant.p<-.07)continue;
      var pos=giantPos(giant),centerY=pos.y-47*pos.s;
      var nearWall=giant.p>.72?(roundDifficulty.nearWallAssist||1.25):1;
      var width=(14+32*pos.s)*roundDifficulty.aimAssist*nearWall;
      var height=(18+50*pos.s)*roundDifficulty.aimAssist*nearWall;
      var distance=Math.hypot((x-pos.x)/width,(y-centerY)/height);
      if(distance<1&&distance<best){chosen=giant;best=distance;}
    }
    return chosen;
  }
  function liveGiant(id) {
    for(var i=0;i<giants.length;i++)if(giants[i].id===id&&!giants[i].state)return giants[i];
    return null;
  }
  function incomingShots(id) {
    var count=0;
    for(var i=0;i<shells.length;i++)if(shells[i].giantId===id)count++;
    return count;
  }
  function retargetCrowdedTap(target) {
    if(!target.giantId)return;
    var original=liveGiant(target.giantId);
    if(original&&original.p<=.72)return;
    if(!original&&target.y<H*.65)return;
    if(original&&incomingShots(original.id)<original.hp)return;
    var replacement=null,best=Infinity,limit=blastRadius(target.y)*1.8;
    for(var i=0;i<giants.length;i++) {
      var giant=giants[i];
      if(giant.state||giant.p<0||incomingShots(giant.id)>=giant.hp)continue;
      var position=giantPos(giant);
      var distance=Math.hypot(position.x-target.x,position.y-47*position.s-target.y);
      if(distance<limit&&distance<best){replacement=giant;best=distance;}
    }
    if(replacement) {
      var next=giantPos(replacement);
      target.giantId=replacement.id;
      target.x=next.x;
      target.y=next.y-47*next.s;
    }
  }
  function shellDuration(distance,giant) {
    var duration=0.38+distance/900;
    if(giant&&giant.p>.72&&giant.speed>0)
      duration=Math.min(duration,Math.max(0.16,(1-giant.p)/giant.speed*0.78));
    return duration;
  }
  function predictedAim(target,cannon) {
    if(!target.giantId)return target;
    var giant=liveGiant(target.giantId);
    if(!giant)return target;
    var sx=cannon.x,sy=wallY()+2,position=giantPos(giant);
    for(var step=0;step<3;step++) {
      var flight=shellDuration(Math.hypot(position.x-sx,position.y-sy),giant);
      position=giantPosAt(giant,giant.p+giant.speed*flight,elapsed+flight);
    }
    return {x:clamp(position.x,8,W-8),y:Math.min(position.y-(giant.kind===0?42:14)*position.s,wallFootY()-8),giantId:giant.id};
  }
  function nearestSoldier(x) {
    var found = -1, distance = Infinity;
    for (var i=0;i<soldiers.length;i++) {
      var d=Math.abs(x-soldierX(i));
      if (soldiers[i] && d<distance) {distance=d;found=i;}
    }
    return found;
  }
  function burst(x, y, color, n, force) {
    for (var i = 0; i < n; i++) {
      var a = rand(0, 6.283), v = rand(force * 0.25, force);
      sparks.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - force * 0.32,
        life: rand(0.25, 0.65), max: 0.65, color: color, r: rand(1.2, 3.7) });
    }
  }
  function bloodBurst(x,y) {
    for(var i=0;i<16;i++){
      var a=rand(0,6.283),v=rand(14,58),life=rand(.42,.78);
      bloodMists.push({x:x+rand(-4,4),y:y+rand(-3,3),vx:Math.cos(a)*v,vy:Math.sin(a)*v-18,
        r:rand(5,11),life:life,max:life,color:i%3?'#963b42':'#b14a4d'});
    }
  }
  function launch(target, cannon) {
    inputDiagnostics.shots++;
    inputDiagnostics.lastShotAt=Math.round(elapsed*10)/10;
    target=predictedAim(target,cannon);
    var sx = cannon.x, sy = wallY() + 2, distance = Math.hypot(target.x - sx, target.y - sy);
    shells.push({ sx: sx, sy: sy, tx: target.x, ty: target.y, giantId: target.giantId, t: 0,
      duration: shellDuration(distance,liveGiant(target.giantId)), arc: 48 + distance * 0.18, trail: [] });
    aimMark = { x: target.x, y: target.y, life: 1.15 };
    cannon.cooldown = roundDifficulty.cannonCooldown;
    cannon.recoil = 1;
    if(!battleFirstShot){battleFirstShot=true;updateMusicVolume();}
    playSound('shot');
    burst(sx, sy - 8, '#ffe4a3', 6, 58);
  }
  function dispatchTargets() {
    for (var expired=targetQueue.length-1;expired>=0;expired--) {
      if (elapsed-targetQueue[expired].queuedAt>1.8) targetQueue.splice(expired,1);
    }
    if (shotGap>0) return;
    var bestTarget=-1,bestCannon=null,bestPriority=-Infinity;
    for (var q=0;q<targetQueue.length;q++) {
      var target=targetQueue[q], choice=null, distance=Infinity;
      retargetCrowdedTap(target);
      for (var i=0;i<cannons.length;i++) {
        var c=cannons[i], d=Math.abs(c.x-target.x);
        if (soldiers[c.crew] && c.cooldown<=0 && d<distance) {choice=c;distance=d;}
      }
      if (choice) {
        var urgent=liveGiant(target.giantId);
        var priority=urgent&&urgent.p>.72?urgent.p:0;
        if(priority>bestPriority){bestTarget=q;bestCannon=choice;bestPriority=priority;}
      }
    }
    if(bestTarget>=0) {
      launch(targetQueue.splice(bestTarget,1)[0],bestCannon);
      shotGap=clamp(tapInterval*.6,roundDifficulty.shotMin,roundDifficulty.shotMax);
    }
  }
  function explode(x, y, radius, canHit) {
    if(canHit)playSound('impact');
    blasts.push({ x: x, y: y, r: radius, life: 0.6, max: 0.6 });
    burst(x, y, '#c69a65', 10, 112);
    burst(x, y, '#645b50', 12, 68);
    if (!canHit) return;
    for (var i = giants.length - 1; i >= 0; i--) {
      if (giants[i].state) continue;
      var p = giantPos(giants[i]);
      var hitY=giants[i].kind===0?clamp(y,p.y-75*p.s,p.y):p.y;
      var hitPadding=giants[i].kind===0?12*p.s:7*p.s;
      if (Math.hypot(p.x - x, hitY - y) <= radius + hitPadding) {
        shake=Math.max(shake,giants[i].kind===0?2.5:1.5);
        giants[i].hp--;
        if(giants[i].kind===0||giants[i].hp<=0)vibrate();
        if (giants[i].hp <= 0) {
          bloodBurst(p.x,p.y-28*p.s);
          giants.splice(i, 1);
        } else burst(p.x,p.y-24*p.s,'#a17e6a',6,48);
      }
    }
    if (mode==='playing' && spawnIndex>=spawnOrder.length && giants.length===0) endGame(x,true);
  }

  function update(dt, realDt) {
    if(realDt===undefined)realDt=dt;
    if(mode==='countdown') {
      countdown=Math.max(0,countdown-dt);
      if(countdown<=0) mode='playing';
      return;
    }
    if(mode==='title'||mode==='paused'||mode==='settings'||mode==='confirmExit') return;
    elapsed += mode === 'playing'||mode === 'settling' ? dt : 0;
    shake = Math.max(0, shake - dt * 25);
    damageFlash = Math.max(0, damageFlash - dt * 1.4);
    if (aimMark) { aimMark.life -= dt; if (aimMark.life <= 0) aimMark = null; }
    for (var i = sparks.length - 1; i >= 0; i--) {
      var sp = sparks[i]; sp.x += sp.vx * dt; sp.y += sp.vy * dt; sp.vy += 105 * dt; sp.life -= dt;
      if (sp.life <= 0) sparks.splice(i, 1);
    }
    for (var bm=bloodMists.length-1;bm>=0;bm--) {
      var mist=bloodMists[bm];mist.x+=mist.vx*dt;mist.y+=mist.vy*dt;
      mist.vx*=0.97;mist.vy=mist.vy*0.97-5*dt;mist.life-=dt;
      if(mist.life<=0)bloodMists.splice(bm,1);
    }
    for (var j = blasts.length - 1; j >= 0; j--) {
      blasts[j].life -= dt;
      if (blasts[j].life <= 0) blasts.splice(j, 1);
    }
    if(mode==='settling') {
      for(var sg=0;sg<giants.length;sg++) {
        if(!giants[sg].state) {
          giants[sg].p=Math.min(1,giants[sg].p+giants[sg].speed*dt);
          if(giants[sg].p>=1)giants[sg].state='climbing';
        }
      }
      for(var sq=shells.length-1;sq>=0;sq--) {
        var settledShell=shells[sq];
        settledShell.t+=dt/settledShell.duration;
        var settledT=clamp(settledShell.t,0,1);
        settledShell.trail.push({
          x:lerp(settledShell.sx,settledShell.tx,settledT),
          y:lerp(settledShell.sy,settledShell.ty,settledT)-Math.sin(settledT*Math.PI)*settledShell.arc
        });
        if(settledShell.trail.length>10)settledShell.trail.shift();
        if(settledShell.t>=1) {
          explode(settledShell.tx,settledShell.ty,blastRadius(settledShell.ty),false);
          shells.splice(sq,1);
        }
      }
      settlementTimer-=realDt;
      if(settlementTimer<=0) {
        mode=settlementResult;
        playMusic(mode==='win'?'win':'lose');
      }
      return;
    }
    if (mode !== 'playing') return;

    shotGap=Math.max(0,shotGap-dt);
    for (var ci=0;ci<cannons.length;ci++) {
      cannons[ci].cooldown=Math.max(0,cannons[ci].cooldown-dt);
      cannons[ci].recoil=Math.max(0,cannons[ci].recoil-dt*6);
    }
    dispatchTargets();
    spawnTimer -= dt;
    if (spawnTimer <= 0 && spawnIndex<spawnOrder.length) {
      spawnGiant();
      spawnTimer = Math.max(roundDifficulty.floor,
        rand(roundDifficulty.intervalMin, roundDifficulty.intervalMax) - elapsed * roundDifficulty.ramp);
    }
    for (var k = giants.length - 1; k >= 0; k--) {
      var giant=giants[k];
      if (!giant.state) giant.p += giant.speed * dt;
    }
    for (var q = shells.length - 1; q >= 0; q--) {
      var shell = shells[q]; shell.t += dt / shell.duration;
      var t = clamp(shell.t, 0, 1), bx = lerp(shell.sx, shell.tx, t);
      var by = lerp(shell.sy, shell.ty, t) - Math.sin(t * Math.PI) * shell.arc;
      shell.trail.push({ x: bx, y: by });
      if (shell.trail.length > 10) shell.trail.shift();
      if (shell.t >= 1) {
        explode(shell.tx, shell.ty, blastRadius(shell.ty), true);
        shells.splice(q, 1);
      }
    }
    if(mode!=='playing')return;
    for (var breach=0;breach<giants.length;breach++) {
      if (!giants[breach].state && giants[breach].p >= 1) {
        giants[breach].p=1;
        giants[breach].state='climbing';
        var breachX=giantPos(giants[breach]).x;
        for(var lost=0;lost<soldiers.length;lost++) {
          if(soldiers[lost]) bloodBurst(soldierX(lost),wallY()+27);
          soldiers[lost]=false;
        }
        damageFlash=0.46;endGame(breachX);return;
      }
    }
  }

  function drawField() {
    if (art.battlefield) {
      // Continue the distant ground behind the transparent gaps in the battlements.
      ctx.drawImage(art.battlefield,0,0,W,wallFootY()+14);
      return;
    }
    var sky = ctx.createLinearGradient(0, 0, 0, H * 0.23);
    sky.addColorStop(0, '#19222b'); sky.addColorStop(0.55, '#4b504c'); sky.addColorStop(1, '#b29a76');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H * 0.24);
    var sun = ctx.createRadialGradient(W*.74,H*.09,3,W*.74,H*.09,65);
    sun.addColorStop(0,'rgba(236,202,143,.46)'); sun.addColorStop(1,'rgba(236,202,143,0)');
    ctx.fillStyle=sun; ctx.fillRect(W*.45,0,W*.55,H*.22);
    ctx.fillStyle = 'rgba(231,200,149,.44)'; ctx.beginPath(); ctx.arc(W * 0.74, H * 0.09, 22, 0, 6.283); ctx.fill();
    ctx.fillStyle='rgba(22,29,32,.33)';
    for (var cl=0;cl<6;cl++) {
      ctx.beginPath(); ctx.ellipse(W*(cl*.21-.04),H*(.05+(cl%3)*.027),48+(cl%2)*24,8+(cl%3)*3,-.08,0,6.283); ctx.fill();
    }
    poly([0,H*.165,34,H*.132,72,H*.155,104,H*.117,139,H*.159,189,H*.127,239,H*.161,285,H*.12,337,H*.151,W,H*.139,W,H*.25,0,H*.25], '#555a57');
    poly([0,H*.179,39,H*.157,86,H*.181,143,H*.159,207,H*.184,267,H*.15,325,H*.184,W,H*.165,W,H*.25,0,H*.25], '#77796c');
    var ground = ctx.createLinearGradient(0, H * 0.16, 0, wallFootY());
    ground.addColorStop(0, '#87986a'); ground.addColorStop(0.42, '#6f875b'); ground.addColorStop(1, '#4c684e');
    ctx.fillStyle = ground; ctx.fillRect(0, H * 0.17, W, wallFootY() - H * 0.17);
    // Large earth shapes and branching tracks give the battlefield one continuous surface.
    poly([0,H*.27,89,H*.25,151,H*.32,211,H*.30,W,H*.26,W,H*.34,279,H*.37,196,H*.36,94,H*.34,0,H*.37], 'rgba(179,183,111,.15)');
    poly([0,H*.51,83,H*.49,157,H*.54,256,H*.5,W,H*.52,W,H*.59,294,H*.57,194,H*.6,65,H*.56,0,H*.58], 'rgba(34,65,42,.17)');
    poly([W*.12,H*.18,W*.19,H*.18,W*.34,wallFootY(),W*.04,wallFootY()], 'rgba(161,148,93,.17)');
    poly([W*.77,H*.18,W*.83,H*.18,W*1.03,wallFootY(),W*.64,wallFootY()], 'rgba(161,148,93,.16)');
    ctx.strokeStyle = 'rgba(31,37,34,.10)'; ctx.lineWidth = 1;
    for (var g = 0; g < 8; g++) {
      var y = H * (0.21 + g * g * 0.0092);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    for (var v = 1; v < 8; v++) {
      ctx.beginPath(); ctx.moveTo(v * W / 8, H * 0.17);
      ctx.lineTo(v * W / 8 + (v - 4) * 13, wallFootY()); ctx.stroke();
    }
    for (var i = 0; i < scenery.length; i++) drawScenery(scenery[i]);
    drawOutpost(W*.08,H*.31,.62);
    drawOutpost(W*.91,H*.42,.78);
    drawOutpost(W*.16,H*.57,1.05);
    drawOutpost(W*.84,H*.59,1.03);
    drawSmoke(W*.075,H*.29,.65);
    drawSmoke(W*.92,H*.40,.9);
  }
  function drawSmoke(x,y,s) {
    ctx.save(); ctx.translate(x,y); ctx.scale(s,s);
    for (var i=0;i<5;i++) {
      var drift=Math.sin(elapsed*.45+i*.8)*4;
      ctx.fillStyle='rgba(38,40,38,'+(0.12-i*.015)+')';
      ctx.beginPath(); ctx.ellipse(drift+i*3,-i*17,10+i*3,8+i*2,-.18,0,6.283); ctx.fill();
    }
    ctx.restore();
  }
  function drawScenery(o) {
    var x = o.x, y = o.y, s = o.s;
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.rotate(o.turn);
    if (o.kind <= 4) {
      ctx.strokeStyle = o.kind & 1 ? '#455641' : '#686c4b'; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-3, -5); ctx.moveTo(0, 0); ctx.lineTo(2, -6);
      ctx.moveTo(0, 0); ctx.lineTo(5, -3); ctx.stroke();
    } else if (o.kind <= 7) {
      poly([-5,1,-2,-3,4,-2,7,1], '#5d5e53', '#414940', 0.6);
      ctx.fillStyle = '#a29a7c'; ctx.fillRect(-2, -2, 3, 1);
    } else {
      ctx.fillStyle = 'rgba(40,48,45,.22)'; ctx.beginPath(); ctx.ellipse(1, 2, 7, 3, 0, 0, 6.283); ctx.fill();
      poly([-5,0,-4,-7,1,-9,5,-5,5,0], '#777565');
      ctx.strokeStyle = '#4d514b'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-4,-7); ctx.lineTo(5,0); ctx.stroke();
    }
    ctx.restore();
  }
  function drawOutpost(x, y, s) {
    ctx.save(); ctx.translate(x,y); ctx.scale(s,s);
    ctx.fillStyle = 'rgba(31,40,35,.28)';
    ctx.beginPath(); ctx.ellipse(8,5,22,7,0,0,6.283); ctx.fill();
    poly([-13,-13,4,-19,19,-13,2,-7], '#aaa18c', '#555951', 1);
    poly([-13,-13,2,-7,2,2,-13,-4], '#75786d', '#51574e', 1);
    poly([2,-7,19,-13,19,-4,2,2], '#575f58', '#3e4a43', 1);
    poly([-17,-14,3,-27,22,-15,19,-12,4,-21,-13,-10], '#584c47', '#3d403d', 1);
    poly([3,-27,22,-15,19,-12,4,-21], '#80655a');
    ctx.fillStyle = '#292d2c'; ctx.fillRect(7,-8,4,5);
    ctx.strokeStyle = '#4d5b55'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-14,-6); ctx.lineTo(-20,-10); ctx.moveTo(18,-2); ctx.lineTo(24,1); ctx.stroke();
    ctx.restore();
  }

  function drawGiant(g) {
    if (g.p < -0.12 || g.state) return;
    var p = giantPos(g), step = Math.sin(elapsed * 10.5 + g.phase), lean = Math.sin(elapsed * 5.25 + g.phase) * 0.15;
    var emerge=clamp((g.p+0.12)/0.20,0,1);
    var sprite=art['giant'+g.kind];
    if (sprite) {
      ctx.save(); ctx.translate(p.x,p.y);
      ctx.globalAlpha=emerge;
      ctx.fillStyle='rgba(25,34,24,.32)';
      ctx.beginPath();ctx.ellipse(0,3,19*p.s,5*p.s,0,0,6.283);ctx.fill();
      ctx.scale(p.s,p.s);
      ctx.rotate(g.state ? Math.sin(elapsed*7+g.phase)*.09 : lean*.45);
      var frame=Math.floor(elapsed*(g.kind===2?9:7)+g.phase)%4;
      var fw=sprite.width/4, widths=[58,72,82,86,74,78];
      ctx.drawImage(sprite,frame*fw,0,fw,sprite.height,-widths[g.kind]/2,-105,widths[g.kind],105);
      ctx.restore(); return;
    }
    var skin = ['#a95b57','#ae8371','#8e6e6b','#aa8474','#ad8973','#988071'][g.kind];
    var light = ['#e4a68c','#d7a891','#c3a099','#d0aa90','#d6ad8d','#c3a28b'][g.kind];
    var shade = ['#623e43','#664c49','#594447','#695249','#705748','#5f4d4a'][g.kind];
    ctx.save(); ctx.translate(p.x, p.y); ctx.scale(p.s, p.s); ctx.globalAlpha=emerge;
    ctx.fillStyle = 'rgba(28,33,31,.28)'; ctx.beginPath(); ctx.ellipse(0, 2, 22, 5, 0, 0, 6.283); ctx.fill();
    ctx.translate(0, -Math.abs(step) * 3); ctx.rotate(lean);
    // Knees lift unevenly while the torso pitches forward, making each stride look unstable.
    poly([-11,-25,-4,-26,-7+step*12,-12,-13+step*15,0,-20+step*14,0,-18+step*7,-14], shade);
    poly([3,-27,11,-27,13-step*10,-12,8-step*14,0,1-step*14,0,1-step*6,-13], skin);
    poly([-20+step*14,-2,-9+step*14,-2,-7+step*14,2,-23+step*14,2], '#3e4141');
    poly([1-step*14,-2,13-step*14,-2,17-step*14,2,-2-step*14,2], '#3e4141');
    poly([-14,-53,-17,-51,-22-step*8,-28,-30-step*10,-17,-36-step*10,-19,-29-step*6,-34,-23,-55], shade);
    poly([13,-55,20,-52,29+step*6,-36,31+step*11,-17,25+step*11,-17,21+step*5,-32], skin);
    poly([-16,-55,-5,-61,13,-56,20,-42,12,-26,-12,-26,-21,-41], skin, '#685255', 0.8);
    poly([-16,-55,-5,-61,-2,-28,-12,-27,-21,-41], light);
    poly([2,-60,13,-56,20,-42,12,-26,3,-28], shade);
    ctx.strokeStyle = '#8a3e43'; ctx.lineWidth = 2.1;
    ctx.beginPath(); ctx.moveTo(-12,-49); ctx.lineTo(-4,-40); ctx.lineTo(-10,-32);
    ctx.moveTo(-3,-58); ctx.lineTo(3,-47); ctx.lineTo(-1,-34);
    ctx.moveTo(10,-53); ctx.lineTo(5,-40); ctx.lineTo(11,-33); ctx.stroke();
    if (g.state === 'climbing' || g.state === 'devouring') {
      ctx.strokeStyle = shade; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(-15,-52); ctx.lineTo(-27,-72); ctx.lineTo(-34,-80);
      ctx.moveTo(17,-52); ctx.lineTo(29,-70); ctx.lineTo(33,-82); ctx.stroke();
      ctx.fillStyle = light; ctx.fillRect(-37,-83,7,6); ctx.fillRect(30,-85,7,6);
    }
    ctx.fillStyle = shade; ctx.fillRect(-4,-68,8,9);
    ctx.fillStyle = light; ctx.beginPath(); ctx.ellipse(0,-77,12,14,0.1,0,6.283); ctx.fill();
    poly([1,-90,11,-85,12,-73,7,-64,1,-67], skin);
    ctx.fillStyle = '#373239'; ctx.fillRect(-5,-79,3,2.5); ctx.fillRect(5,-78,3,2.5);
    ctx.fillStyle='#5c3136'; ctx.fillRect(-2,-70,11,4);
    ctx.fillStyle='#f0d7bd'; for (var tooth=0;tooth<3;tooth++) ctx.fillRect(tooth*3-1,-70,2,2);
    ctx.restore();
  }

  function drawWall() {
    var top=wallY();
    if (art.wall) {
      ctx.drawImage(art.wall,0,top,W,H-top);
    } else {
      ctx.fillStyle='#715747';ctx.fillRect(0,top,W,H-top);
    }
  }
  function drawCannon(cannon) {
    if (!soldiers[cannon.crew]) return;
    var x = cannon.x, y = wallY()+43;
    ctx.save(); ctx.translate(x,y+cannon.recoil*3);
    if (art.crew) {
      ctx.drawImage(art.crew,-28,-53,56,53);
      ctx.restore(); return;
    }
    ctx.fillStyle = 'rgba(15,25,27,.38)'; ctx.beginPath(); ctx.ellipse(0,22,39,9,0,0,6.283); ctx.fill();
    poly([-26,10,26,10,33,22,-33,22], '#313f43', '#8c9188', 1);
    poly([-20,-5,-7,-15,7,-15,20,-5,20,12,-20,12], '#54635e', '#a0a898', 1.2);
    poly([-8,-8,-6,-42,6,-42,8,-8], '#82918c', '#c0c6b3', 1);
    poly([-6,-42,-4,-52,4,-52,6,-42], '#333f42', '#d3d5bd', 1);
    ctx.fillStyle = '#28383c'; rounded(-8,0,16,10,3); ctx.fill();
    ctx.fillStyle = '#e9ce8c'; ctx.beginPath(); ctx.arc(0,4,3,0,6.283); ctx.fill();
    ctx.restore();
  }

  function drawShells() {
    for (var i = 0; i < shells.length; i++) {
      var sh = shells[i], t = clamp(sh.t,0,1);
      ctx.save(); ctx.lineCap = 'round';
      for (var j = 1; j < sh.trail.length; j++) {
        var a = sh.trail[j-1], b = sh.trail[j];
        ctx.strokeStyle = 'rgba(112,103,89,' + (j / sh.trail.length * 0.27) + ')';
        ctx.lineWidth = 1.2 + j / sh.trail.length * 1.8;
        ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      }
      var px = lerp(sh.sx,sh.tx,t), py = lerp(sh.sy,sh.ty,t) - Math.sin(t*Math.PI)*sh.arc;
      ctx.shadowColor = 'rgba(213,165,99,.6)'; ctx.shadowBlur = 5;
      var shot=ctx.createRadialGradient(px-1.5,py-1.5,.4,px,py,4.1-1.1*t);
      shot.addColorStop(0,'#d6c9ad');shot.addColorStop(.42,'#77736b');shot.addColorStop(1,'#302f2c');
      ctx.fillStyle=shot;ctx.beginPath();ctx.arc(px,py,4.1-1.1*t,0,6.283);ctx.fill();
      ctx.restore();
    }
  }
  function drawEffects() {
    for (var i = 0; i < blasts.length; i++) {
      var b = blasts[i], progress = 1 - b.life / b.max, fade=b.life/b.max;
      ctx.save();
      ctx.globalAlpha=fade*.48;
      var dust=ctx.createRadialGradient(b.x,b.y,2,b.x,b.y,b.r*(.35+progress*.9));
      dust.addColorStop(0,'rgba(160,132,98,.72)');dust.addColorStop(.55,'rgba(115,101,82,.5)');dust.addColorStop(1,'rgba(75,69,60,0)');
      ctx.fillStyle=dust;ctx.beginPath();ctx.ellipse(b.x,b.y,b.r*(.3+progress*.72),b.r*(.12+progress*.38),0,0,6.283);ctx.fill();
      ctx.globalAlpha=Math.max(0,1-progress*4)*.65;
      var flash=ctx.createRadialGradient(b.x,b.y,1,b.x,b.y,b.r*.42);
      flash.addColorStop(0,'rgba(255,224,166,.95)');flash.addColorStop(.28,'rgba(226,155,83,.7)');flash.addColorStop(1,'rgba(166,92,53,0)');
      ctx.fillStyle=flash;ctx.beginPath();ctx.arc(b.x,b.y,b.r*.42,0,6.283);ctx.fill();
      ctx.globalAlpha=fade*.27;ctx.strokeStyle='rgba(183,146,101,.7)';ctx.lineWidth=1.5*fade;
      ctx.beginPath();ctx.ellipse(b.x,b.y+2,b.r*(.22+progress*.72),b.r*(.08+progress*.24),0,0,6.283);ctx.stroke();
      ctx.restore();
    }
    for (var j = 0; j < sparks.length; j++) {
      var p = sparks[j]; ctx.globalAlpha = clamp(p.life/p.max,0,1);
      ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,6.283); ctx.fill();
    }
    for(var m=0;m<bloodMists.length;m++){
      var mist=bloodMists[m],fade=mist.life/mist.max,spread=1+(1-fade)*1.7;
      ctx.save();ctx.globalAlpha=fade*.42;
      var grad=ctx.createRadialGradient(mist.x,mist.y,1,mist.x,mist.y,mist.r*spread);
      grad.addColorStop(0,mist.color);grad.addColorStop(.62,'rgba(116,38,43,.72)');grad.addColorStop(1,'rgba(83,34,39,0)');
      ctx.fillStyle=grad;ctx.beginPath();ctx.arc(mist.x,mist.y,mist.r*spread,0,6.283);ctx.fill();ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  function drawAim() {
    if (!aimMark || mode !== 'playing') return;
    var a = aimMark, alpha = clamp(a.life,0,1);
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = '#ffe4a8'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(a.x,a.y,14 + (1-alpha)*8,0,6.283); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(a.x-23,a.y); ctx.lineTo(a.x-10,a.y);
    ctx.moveTo(a.x+10,a.y); ctx.lineTo(a.x+23,a.y);
    ctx.moveTo(a.x,a.y-23); ctx.lineTo(a.x,a.y-10);
    ctx.moveTo(a.x,a.y+10); ctx.lineTo(a.x,a.y+23); ctx.stroke();
    ctx.restore();
  }
  function drawPauseControl() {
    var hudY=hudTop();
    ctx.fillStyle = 'rgba(47,59,64,.58)'; rounded(W-59,hudY,45,45,12); ctx.fill();
    ctx.fillStyle = '#fff6dd'; ctx.fillRect(W-44,hudY+12,5,21); ctx.fillRect(W-33,hudY+12,5,21);
  }
  function drawHUD() {
    drawPauseControl();
    if(showInputDiagnostics) {
      label('触摸 '+inputDiagnostics.starts+'/'+inputDiagnostics.ends+'  鼠标 '+inputDiagnostics.pointer+
        '  落点 '+inputDiagnostics.accepted+'  发射 '+inputDiagnostics.shots+
        '  排队 '+targetQueue.length+'  备用'+(devPointerFallback?'开':'无'),
        12,H*.938,11,'#fff1d4','left','normal');
    }
    label('点击草地指定落点 · 三门炮台接力开火',W/2,H*.973,12,'#eee4c9','center','normal');
  }
  function button(s, y, secondary, height, width) {
    height=height||54;
    width=width||196;
    ctx.save();
    ctx.shadowColor=secondary?'transparent':'rgba(255,203,141,.23)';ctx.shadowBlur=secondary?0:16;
    ctx.fillStyle=secondary?'rgba(89,108,107,.58)':'#e9c98e';
    rounded(W/2-width/2,y,width,height,14);ctx.fill();ctx.shadowBlur=0;
    if(secondary){ctx.strokeStyle='rgba(215,225,216,.42)';ctx.lineWidth=1;ctx.stroke();}
    label(s,W/2,y+height/2+1,17,secondary?'#f0f2e8':'#283137','center');
    ctx.restore();
  }
  function drawHomeEmblem(x,y) {
    ctx.save();
    ctx.shadowColor='rgba(235,206,145,.38)';ctx.shadowBlur=12;
    ctx.beginPath();ctx.moveTo(x,y-22);ctx.lineTo(x+18,y-14);
    ctx.lineTo(x+16,y+4);ctx.quadraticCurveTo(x+11,y+17,x,y+22);
    ctx.quadraticCurveTo(x-11,y+17,x-16,y+4);ctx.lineTo(x-18,y-14);ctx.closePath();
    ctx.fillStyle='#cdb77e';ctx.fill();ctx.shadowBlur=0;
    ctx.strokeStyle='#f3e0ac';ctx.lineWidth=1.5;ctx.stroke();
    ctx.fillStyle='#465550';ctx.fillRect(x-9,y-2,18,13);
    for(var i=0;i<3;i++)ctx.fillRect(x-9+i*7,y-7,4,7);
    ctx.restore();
  }
  function drawHomeOverlay() {
    var controlsY=homeControlsY();
    var titleY=Math.max(hudTop()+90,Math.min(H*.44,controlsY-115));
    var topShade=ctx.createLinearGradient(0,titleY-112,0,titleY+95);
    topShade.addColorStop(0,'rgba(9,18,23,0)');
    topShade.addColorStop(.48,'rgba(9,18,23,.37)');
    topShade.addColorStop(1,'rgba(9,18,23,0)');
    ctx.fillStyle=topShade;ctx.fillRect(0,titleY-112,W,207);
    var controlsShade=ctx.createLinearGradient(0,controlsY-80,0,wallY());
    controlsShade.addColorStop(0,'rgba(10,21,24,0)');
    controlsShade.addColorStop(.32,'rgba(10,21,24,.44)');
    controlsShade.addColorStop(.75,'rgba(10,21,24,.55)');
    controlsShade.addColorStop(1,'rgba(10,21,24,.10)');
    ctx.fillStyle=controlsShade;ctx.fillRect(0,controlsY-80,W,wallY()-controlsY+80);
    drawHomeEmblem(W/2,titleY-59);
    ctx.save();ctx.shadowColor='rgba(0,0,0,.75)';ctx.shadowBlur=15;
    label('城墙防线',W/2,titleY,40,'#fff1ce','center');
    label('奇异种来袭',W/2,titleY+38,18,'#d9a99a','center');
    ctx.restore();
    label('选择难度',W/2,controlsY-19,14,'#e4e6d9','center');
    drawDifficultyPicker(controlsY+5);
    var loadingArt=isWX&&wx.loadSubpackage&&!allArtReady();
    button(loadingArt?(artLoadError?'重试加载素材':'素材加载中'):'开始游戏',controlsY+59,false,56,224);
    button('游戏设置',controlsY+127,true,44,150);
  }
  function drawResultEmblem(x,y,won) {
    ctx.save();
    ctx.shadowColor=won?'rgba(232,205,133,.35)':'rgba(190,108,97,.28)';
    ctx.shadowBlur=12;
    ctx.beginPath();ctx.moveTo(x,y-22);ctx.lineTo(x+18,y-14);
    ctx.lineTo(x+16,y+4);ctx.quadraticCurveTo(x+11,y+17,x,y+22);
    ctx.quadraticCurveTo(x-11,y+17,x-16,y+4);ctx.lineTo(x-18,y-14);ctx.closePath();
    ctx.fillStyle=won?'#cfb77d':'#a87670';ctx.fill();ctx.shadowBlur=0;
    ctx.strokeStyle=won?'#f4e3b8':'#dbaca3';ctx.lineWidth=1.5;ctx.stroke();
    ctx.beginPath();
    if(won){ctx.moveTo(x-9,y);ctx.lineTo(x-2,y+7);ctx.lineTo(x+10,y-7);}
    else{ctx.moveTo(x+3,y-16);ctx.lineTo(x-3,y-3);ctx.lineTo(x+4,y+1);ctx.lineTo(x-3,y+16);}
    ctx.strokeStyle=won?'#fff4d9':'#3d3032';ctx.lineWidth=3;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke();
    ctx.restore();
  }
  function drawDifficultyPicker(y) {
    var choices = ['easy','normal','hard'];
    for (var i=0;i<choices.length;i++) {
      var key=choices[i], selected=settings.difficulty===key, x=W/2-114+i*79;
      ctx.fillStyle=selected?'#e9c98e':'rgba(89,108,107,.72)';
      rounded(x,y,70,38,10);ctx.fill();
      if(!selected){ctx.strokeStyle='rgba(215,225,216,.42)';ctx.lineWidth=1;ctx.stroke();}
      label(DIFFICULTIES[key].label,x+35,y+20,15,selected?'#283137':'#f0f2e8','center');
    }
  }
  function drawVolumeSlider(title,y,value,muted) {
    var x=W/2-103,w=206;
    label(title,x,y-33,16,'#e3e9df');
    label(Math.round(value*100)+'%',x+146,y-33,15,muted?'#a9b4ad':'#f1d59c','right');
    drawMuteIcon(W/2+105,y-34,muted);
    ctx.lineCap='round';ctx.lineWidth=8;
    ctx.strokeStyle='rgba(201,213,206,.25)';ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+w,y);ctx.stroke();
    ctx.strokeStyle=muted?'#788580':'#e2c186';ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+w*value,y);ctx.stroke();
    ctx.fillStyle=muted?'#a8b3ad':'#fff2d0';ctx.beginPath();ctx.arc(x+w*value,y,11,0,6.283);ctx.fill();
    ctx.strokeStyle='#785f43';ctx.lineWidth=2;ctx.stroke();
  }
  function drawMuteIcon(x,y,muted) {
    ctx.save();
    ctx.fillStyle=muted?'rgba(139,93,89,.9)':'rgba(67,88,84,.9)';
    ctx.beginPath();ctx.arc(x,y,18,0,6.283);ctx.fill();
    ctx.strokeStyle=muted?'rgba(235,175,164,.85)':'rgba(214,226,214,.65)';
    ctx.lineWidth=1;ctx.stroke();
    ctx.fillStyle='#f2e9d5';
    ctx.beginPath();ctx.moveTo(x-10,y-4);ctx.lineTo(x-6,y-4);
    ctx.lineTo(x-1,y-8);ctx.lineTo(x-1,y+8);
    ctx.lineTo(x-6,y+4);ctx.lineTo(x-10,y+4);ctx.closePath();ctx.fill();
    ctx.strokeStyle='#f2e9d5';ctx.lineWidth=2;ctx.lineCap='round';
    if(muted) {
      ctx.beginPath();ctx.moveTo(x+3,y-6);ctx.lineTo(x+11,y+6);ctx.stroke();
      ctx.beginPath();ctx.moveTo(x+11,y-6);ctx.lineTo(x+3,y+6);ctx.stroke();
    } else {
      ctx.beginPath();ctx.arc(x-1,y,7,-.75,.75);ctx.stroke();
      ctx.beginPath();ctx.arc(x-1,y,11,-.68,.68);ctx.stroke();
    }
    ctx.restore();
  }
  function drawOverlay() {
    var resultScreen=mode==='over'||mode==='win';
    ctx.fillStyle = mode==='countdown'?'rgba(13,22,30,.52)':mode==='title'?'rgba(13,22,30,.18)':resultScreen?'rgba(13,22,30,.65)':'rgba(13,22,30,.77)';
    ctx.fillRect(0,0,W,H);
    if(mode==='title'){drawHomeOverlay();return;}
    var y = resultScreen?resultOverlayY():H*.35;
    if(mode==='countdown') {
      label('守城准备',W/2,H*.37,23,'#f1e2c2','center');
      label(String(Math.ceil(countdown)),W/2,H*.47,82,'#fff3d6','center');
      label(roundDifficulty.label+'难度 · 50只怪物',W/2,H*.54,14,'#f1d59c','center');
      label('点击草地指定炮击落点',W/2,H*.57,15,'#e1e5d9','center','normal');
      return;
    }
    if(resultScreen){
      var panel=ctx.createLinearGradient(0,y-105,0,y+195);
      panel.addColorStop(0,mode==='win'?'#21302e':'#2c2728');
      panel.addColorStop(1,mode==='win'?'#172527':'#1c2529');
      ctx.fillStyle=panel;rounded(W/2-145,y-105,290,300,22);ctx.fill();
      ctx.strokeStyle=mode==='win'?'rgba(229,204,151,.48)':'rgba(210,152,141,.48)';
    } else {
      ctx.fillStyle='rgba(23,34,39,.84)';rounded(W/2-145,y-135,290,380,22);ctx.fill();
      ctx.strokeStyle='rgba(221,206,168,.32)';
    }
    ctx.lineWidth=1;ctx.stroke();
    if (mode === 'paused') {
      label('游戏暂停',W/2,y-80,32,'#fff4d7','center');
      label('城墙仍在等待你的命令',W/2,y-41,14,'#bac9c4','center','normal');
      button('继续游戏',y+5);
      button('游戏设置',y+72,true);
      button('退出游戏',y+139,true);
    } else if(mode==='settings') {
      label('游戏设置',W/2,y-89,31,'#fff4d7','center');
      drawVolumeSlider('音效音量',y-8,settings.volume,settings.sfxMuted);
      drawVolumeSlider('背景音乐',y+60,settings.music,settings.musicMuted);
      button('震动反馈：'+(settings.vibration?'开':'关'),y+94,true);
      button('返回',y+159);
    } else if(mode==='confirmExit') {
      label('退出本局？',W/2,y-81,31,'#fff4d7','center');
      label('当前进度不会保留',W/2,y-25,15,'#d2d9d1','center','normal');
      button('继续守城',y+53);
      button('退出到首页',y+120,true);
    } else if (mode === 'over' || mode === 'win') {
      ctx.fillStyle='rgba(221,206,168,.14)';rounded(W/2-49,y-89,98,26,13);ctx.fill();
      label(roundDifficulty.label+'难度',W/2,y-76,12,'#e6d0a0','center');
      drawResultEmblem(W/2,y-26,mode==='win');
      label(mode==='win'?'守卫成功':'城墙失守',W/2,y+25,31,mode==='win'?'#f0dfad':'#dca095','center');
      button('再次守城',y+RESULT_RETRY_Y,false,50);
      button('返回首页',y+RESULT_HOME_Y,true,50);
    }
  }
  function render() {
    ctx.setTransform(canvas.width/W,0,0,canvas.height/H,0,0);
    if(isWX&&wx.loadSubpackage&&!allArtReady()) {
      ctx.fillStyle='#111c20';ctx.fillRect(0,0,W,H);
      drawHomeEmblem(W/2,H*.43);
      label('城墙防线',W/2,H*.5,35,'#fff1ce','center');
      label(artLoadError?'素材加载失败 · 轻触屏幕重试':'正在加载游戏素材',W/2,H*.57,15,'#d6d4c5','center','normal');
      return;
    }
    ctx.save(); if (shake) ctx.translate(rand(-shake,shake),rand(-shake,shake));
    drawField();
    giants.sort(function (a,b) { return a.p-b.p; });
    for (var i=0;i<giants.length;i++) if (!giants[i].state) drawGiant(giants[i]);
    drawWall();
    for (var gun=0;gun<cannons.length;gun++) drawCannon(cannons[gun]);
    drawEffects();
    drawShells(); drawAim();
    ctx.restore(); if(mode==='playing') drawHUD();
    if (damageFlash) { ctx.fillStyle='rgba(255,72,61,'+(damageFlash*.22)+')'; ctx.fillRect(0,0,W,H); }
    if (mode!=='playing'&&mode!=='settling') drawOverlay();
    if (mode==='countdown') drawPauseControl();
  }
  function tick(stamp) {
    if (!lastFrame) lastFrame=stamp;
    var realDt=Math.max(0,(stamp-lastFrame)/1000);
    var dt=clamp(realDt,0,0.05); lastFrame=stamp;
    update(dt,realDt); render();
    if (canvas.requestAnimationFrame) canvas.requestAnimationFrame(tick); else requestAnimationFrame(tick);
  }
  function point(t) {
    var tx=Number.isFinite(t.clientX)?t.clientX:(Number.isFinite(t.pageX)?t.pageX:t.x);
    var ty=Number.isFinite(t.clientY)?t.clientY:(Number.isFinite(t.pageY)?t.pageY:t.y);
    if (isWX) {
      return {x:tx*W/screenW,y:ty*H/screenH};
    }
    var r=canvas.getBoundingClientRect();
    return {x:(tx-r.left)*W/r.width,y:(ty-r.top)*H/r.height};
  }
  function hitButton(p,y,height,width) {
    width=width||196;
    return p.x>=W/2-width/2-8&&p.x<=W/2+width/2+8&&p.y>=y-5&&p.y<=y+(height||54)+5;
  }
  function changeVolume(p,kind) {
    var value=Math.round(clamp((p.x-(W/2-103))/206,0,1)*20)/20;
    if(kind==='music'){settings.music=value;settings.musicMuted=false;updateMusicVolume();}
    else {settings.volume=value;settings.sfxMuted=false;}
  }
  function hitMuteButton(p,y) {
    return Math.hypot(p.x-(W/2+105),p.y-(y-34))<=22;
  }
  function isPauseTap(p) { return p.x>=W-65&&p.y>=hudTop()-6&&p.y<=hudTop()+51; }
  function pauseGame() {
    if(mode!=='playing'&&mode!=='countdown')return;
    pausedFrom=mode;mode='paused';pauseMusic();targetQueue=[];
  }
  function handleHide() {
    if(mode==='playing'||mode==='countdown')pauseGame();
    else pauseMusic();
  }
  function handleShow() {
    if(mode==='title'||mode==='win'||mode==='over'||mode==='settling'||
      (mode==='settings'&&settingsReturn==='title'))resumeMusic();
  }
  function resumeGame() { mode=pausedFrom;resumeMusic(); }
  function returnHome() {
    stopMusic();
    mode='title';giants=[];shells=[];blasts=[];sparks=[];bloodMists=[];
    targetQueue=[];aimMark=null;soldiers=[true,true,true];setupCannons();
    playMusic('title');
  }
  function tap(t) {
    var p=point(t), y=H*.35;
    if(!isFinite(p.x)||!isFinite(p.y))return;
    if(isWX&&wx.loadSubpackage&&!allArtReady()) {
      if(artLoadError)loadGameArt();
      return;
    }
    if(mode==='title') {
      var controlsY=homeControlsY();
      if(p.y>=controlsY&&p.y<=controlsY+48) {
        var choices=['easy','normal','hard'];
        for(var d=0;d<choices.length;d++) {
          var x=W/2-114+d*79;
          if(p.x>=x-4&&p.x<=x+74) {
            if(settings.difficulty!==choices[d]){settings.difficulty=choices[d];saveSettings();playSound('ui');}
            return;
          }
        }
      }
      if(hitButton(p,controlsY+59,56,224)){playSound('ui');startGame();}
      else if(hitButton(p,controlsY+127,44,150)){playSound('ui');settingsReturn='title';mode='settings';}
      return;
    }
    if(mode==='countdown') {
      if(isPauseTap(p)){playSound('ui');pauseGame();}
      return;
    }
    if(mode==='settings') {
      if(hitMuteButton(p,y-8)) {
        settings.sfxMuted=!settings.sfxMuted;saveSettings();playSound('ui');return;
      }
      if(hitMuteButton(p,y+60)) {
        settings.musicMuted=!settings.musicMuted;updateMusicVolume();saveSettings();playSound('ui');return;
      }
      if(p.x>=W/2-120&&p.x<=W/2+120&&p.y>=y-24&&p.y<=y-2) {
        draggingVolume='sfx';changeVolume(p,draggingVolume);return;
      }
      if(p.x>=W/2-120&&p.x<=W/2+120&&p.y>=y+44&&p.y<=y+66) {
        draggingVolume='music';changeVolume(p,draggingVolume);return;
      }
      if(hitButton(p,y+94)){
        settings.vibration=!settings.vibration;saveSettings();playSound('ui');if(settings.vibration)vibrate();
      } else if(hitButton(p,y+159)){
        playSound('ui');mode=settingsReturn;
      }
      return;
    }
    if(mode==='paused') {
      if(hitButton(p,y+5)){playSound('ui');resumeGame();}
      else if(hitButton(p,y+72)){playSound('ui');settingsReturn='paused';mode='settings';}
      else if(hitButton(p,y+139)){playSound('ui');mode='confirmExit';}
      return;
    }
    if(mode==='confirmExit') {
      if(hitButton(p,y+53)){playSound('ui');mode='paused';}
      else if(hitButton(p,y+120)){playSound('ui');returnHome();}
      return;
    }
    if(mode==='over'||mode==='win') {
      y=resultOverlayY();
      if(hitButton(p,y+RESULT_RETRY_Y,50)){playSound('ui');startGame();}
      else if(hitButton(p,y+RESULT_HOME_Y,50)){playSound('ui');returnHome();}
      return;
    }
    if(mode!=='playing')return;
    if(isPauseTap(p)){playSound('ui');pauseGame();return;}
    if (p.y<H*.14 || p.y>wallFootY()+28) return;
    var target={x:clamp(p.x,8,W-8),y:Math.min(p.y,wallFootY()-8),queuedAt:elapsed};
    var selected=aimedGiant(target.x,p.y);
    if(p.y>wallFootY()+8&&!selected)return;
    if(selected)target.giantId=selected.id;
    targetQueue.push(target);
    if (targetQueue.length>18) targetQueue.shift();
    aimMark={x:target.x,y:target.y,life:1.15};
    inputDiagnostics.accepted++;
    inputDiagnostics.lastAcceptedAt=Math.round(elapsed*10)/10;
    if (elapsed-lastTap<0.7) tapInterval=clamp(tapInterval*.65+(elapsed-lastTap)*.35,.06,.3);
    else tapInterval=.18;
    lastTap=elapsed;
    dispatchTargets();
  }
  resize();
  if (isWX) {
    var activeTouchIds={}, recentStarts=[], recentPointers=[];
    function sameRecentTouch(a,b,windowMs) {
      return a&&b&&Date.now()-a.time<windowMs&&Math.hypot(a.x-b.x,a.y-b.y)<18;
    }
    function recentMatch(list,p,windowMs) {
      for(var i=list.length-1;i>=0;i--) {
        if(Date.now()-list[i].time>=windowMs){list.splice(i,1);continue;}
        if(sameRecentTouch(list[i],p,windowMs))return true;
      }
      return false;
    }
    function rememberTouch(list,p) {
      list.push({x:p.x,y:p.y,time:Date.now()});
      if(list.length>12)list.shift();
    }
    wx.onTouchStart(function (e) {
      var touches=e.changedTouches||e.touches;
      if(!touches||!touches.length)return;
      for(var i=0;i<touches.length;i++) {
        var touch=touches[i],key=touch.identifier;
        if(key!==undefined&&activeTouchIds[key])continue;
        if(key!==undefined)activeTouchIds[key]=true;
        var p=point(touch);
        if(mode==='playing'){inputDiagnostics.starts++;inputDiagnostics.lastTouchAt=Math.round(elapsed*10)/10;}
        rememberTouch(recentStarts,p);
        if(!recentMatch(recentPointers,p,90))tap(touch);
      }
    });
    wx.onTouchMove(function(e){if(draggingVolume&&mode==='settings'&&e.changedTouches.length)changeVolume(point(e.changedTouches[0]),draggingVolume);});
    wx.onTouchEnd(function(e){
      var touches=e&&(e.changedTouches||e.touches);
      if(touches&&touches.length){
        for(var i=0;i<touches.length;i++) {
          var touch=touches[i],key=touch.identifier,p=point(touch);
          if(mode==='playing'){inputDiagnostics.ends++;inputDiagnostics.lastTouchAt=Math.round(elapsed*10)/10;}
          var started=key!==undefined&&activeTouchIds[key];
          if(key!==undefined)delete activeTouchIds[key];
          if(!started&&!recentMatch(recentStarts,p,500)&&!recentMatch(recentPointers,p,90))tap(touch);
        }
      }
      if(draggingVolume){draggingVolume=null;saveSettings();}
    });
    if(wx.onTouchCancel)wx.onTouchCancel(function(){activeTouchIds={};if(draggingVolume){draggingVolume=null;saveSettings();}});
    if(wx.onHide)wx.onHide(handleHide);
    if(wx.onShow)wx.onShow(handleShow);
    if (wx.onWindowResize) wx.onWindowResize(resize);
    if(showInputDiagnostics&&typeof canvas.addEventListener==='function') {
      devPointerFallback=true;
      canvas.addEventListener('pointerdown',function(e) {
        var pointer=e;
        if(typeof canvas.getBoundingClientRect==='function'&&isFinite(e.clientX)&&isFinite(e.clientY)) {
          var rect=canvas.getBoundingClientRect();
          pointer={x:(e.clientX-rect.left)*screenW/rect.width,
            y:(e.clientY-rect.top)*screenH/rect.height};
        }
        var p=point(pointer);
        if(!isFinite(p.x)||!isFinite(p.y))return;
        inputDiagnostics.pointer++;
        var duplicate=recentMatch(recentStarts,p,90);
        rememberTouch(recentPointers,p);
        if(!duplicate)tap(pointer);
      });
    }
  } else {
    canvas.addEventListener('pointerdown',function(e) { tap(e); });
    canvas.addEventListener('pointermove',function(e){if(draggingVolume&&mode==='settings')changeVolume(point(e),draggingVolume);});
    window.addEventListener('pointerup',function(){if(draggingVolume){draggingVolume=null;saveSettings();}});
    window.addEventListener('pointercancel',function(){if(draggingVolume){draggingVolume=null;saveSettings();}});
    window.addEventListener('blur',handleHide);
    window.addEventListener('focus',handleShow);
    window.addEventListener('keydown',function(e) {
      if (e.code==='Enter'&&(mode==='title'||mode==='over'||mode==='win')) startGame();
      if(e.code==='Escape') {
        if(mode==='playing'||mode==='countdown')pauseGame();
        else if(mode==='paused')resumeGame();
        else if(mode==='settings')mode=settingsReturn;
        else if(mode==='confirmExit')mode='paused';
      }
    });
    window.addEventListener('resize',resize);
  }
  // Keep the audio mixer fully initialized before the first music track starts.
  prepareSoundPool('ui'); prepareSoundPool('shot'); prepareSoundPool('impact');
  setupCannons(); playMusic('title');
  loadArt('crew','assets/gun-crew.png');
  loadGameArt();
  if (canvas.requestAnimationFrame) canvas.requestAnimationFrame(tick); else requestAnimationFrame(tick);
})();





