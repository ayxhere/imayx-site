(function(){
var $=function(s,r){return (r||document).querySelector(s)},$$=function(s,r){return [].slice.call((r||document).querySelectorAll(s))};
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;

// scroll progress
var bar=$('#bar');
function prog(){var h=document.documentElement;var m=h.scrollHeight-h.clientHeight;if(bar)bar.style.width=(m>0?h.scrollTop/m*100:0)+'%'}
addEventListener('scroll',prog,{passive:true});prog();

// reveal
var rv=$$('.rv');
if('IntersectionObserver' in window&&!reduce){
  var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{threshold:.12,rootMargin:'0px 0px -40px 0px'});
  rv.forEach(function(el,i){if(!el.style.getPropertyValue('--d'))el.style.setProperty('--d',(i%4)*.08+'s');io.observe(el)});
}else rv.forEach(function(el){el.classList.add('in')});

// card glow
$$('.card').forEach(function(c){c.addEventListener('pointermove',function(e){var r=c.getBoundingClientRect();c.style.setProperty('--mx',(e.clientX-r.left)+'px');c.style.setProperty('--my',(e.clientY-r.top)+'px')})});

// counters
function count(el){var to=parseFloat(el.dataset.to),suf=el.dataset.suf||'',dec=(el.dataset.dec|0),t0=null;
  if(reduce){el.textContent=to.toFixed(dec)+suf;return}
  function f(t){if(!t0)t0=t;var p=Math.min((t-t0)/1400,1),e=1-Math.pow(1-p,3);el.textContent=(to*e).toFixed(dec)+suf;if(p<1)requestAnimationFrame(f)}requestAnimationFrame(f)}
if('IntersectionObserver' in window){var co=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){count(e.target);co.unobserve(e.target)}})},{threshold:.5});$$('[data-to]').forEach(function(el){co.observe(el)})}
else $$('[data-to]').forEach(count);

// phone carousel: 6 screens, swipe / dots / nav / autoplay
var deck=$('#deck');
if(deck){
  var slides=$('#slides'),panes=$$('.pane',slides),N=panes.length,idx=0;
  var navB=$$('#snav button'),dotB=$$('#dots button'),lbl=$('#deckLbl');
  var chat=$('#chat'),msgs=chat?$$('.msg',chat):[],typing=chat?$('.typing',chat):null,ctimers=[];
  var auto=null,idle=0,vis=true;

  // stagger index for in-pane entrance
  panes.forEach(function(p){$$('.stg>*',p).forEach(function(el,i){el.style.setProperty('--i',i)})});

  function clearChat(){ctimers.forEach(clearTimeout);ctimers=[];msgs.forEach(function(m){m.classList.remove('show')});typing&&typing.classList.remove('show')}
  function playChat(){
    clearChat();
    if(reduce){msgs.forEach(function(m){m.classList.add('show')});return}
    var script=[[350,0],[1300,'t'],[2500,1],[3900,2],[4800,'t'],[6000,3],[7600,4]];
    script.forEach(function(st){ctimers.push(setTimeout(function(){
      if(st[1]==='t'){typing.classList.add('show');chat.appendChild(typing)}
      else{typing.classList.remove('show');msgs[st[1]].classList.add('show')}
    },st[0]))});
  }

  function width(){return deck.clientWidth}
  function setX(px,anim){slides.style.transform='translate3d('+px+'px,0,0)'}
  function go(i,user){
    i=Math.max(0,Math.min(N-1,i));
    var changed=i!==idx;idx=i;
    setX(-idx*width());
    panes.forEach(function(p,k){p.classList.toggle('active',k===idx);p.setAttribute('aria-hidden',k===idx?'false':'true')});
    navB.forEach(function(b,k){b.classList.toggle('on',k===idx)});
    dotB.forEach(function(b,k){b.classList.toggle('on',k===idx)});
    if(lbl)lbl.textContent=panes[idx].dataset.name;
    if(chat){if(idx===1)playChat();else clearChat()}
    if(user)idle=Date.now();
    return changed;
  }
  addEventListener('resize',function(){go(idx)});

  // drag / swipe
  var sx=0,sy=0,dx=0,down=false,lock=null,t0=0;
  deck.addEventListener('pointerdown',function(e){
    if(e.pointerType==='mouse'&&e.button!==0)return;
    down=true;lock=null;sx=e.clientX;sy=e.clientY;dx=0;t0=Date.now();
  });
  deck.addEventListener('pointermove',function(e){
    if(!down)return;
    var mx=e.clientX-sx,my=e.clientY-sy;
    if(lock===null){
      if(Math.abs(mx)>8&&Math.abs(mx)>Math.abs(my)){lock='x';deck.classList.add('drag');try{deck.setPointerCapture(e.pointerId)}catch(_){}}
      else if(Math.abs(my)>10){lock='y';down=false;return}
      else return;
    }
    if(lock==='x'){
      dx=mx;
      if((idx===0&&dx>0)||(idx===N-1&&dx<0))dx*=.3; // edge resistance
      setX(-idx*width()+dx);
    }
  });
  function end(){
    if(!down&&lock!=='x'){down=false;return}
    down=false;deck.classList.remove('drag');
    if(lock==='x'){
      var v=Math.abs(dx)/Math.max(1,Date.now()-t0);
      if(Math.abs(dx)>width()*.16||v>.45)go(idx+(dx<0?1:-1),true);else go(idx,true);
    }
    lock=null;dx=0;
  }
  deck.addEventListener('pointerup',end);
  deck.addEventListener('pointercancel',end);
  deck.addEventListener('pointerleave',function(){if(down&&lock==='x')end()});

  // taps: nav icons, dots, in-screen links
  $$('[data-go]').forEach(function(el){el.addEventListener('click',function(e){
    var n=parseInt(el.getAttribute('data-go'),10);if(!isNaN(n)){e.stopPropagation();go(n,true)}
  })});
  deck.tabIndex=0;
  deck.addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'){go(idx+1,true);e.preventDefault()}
    if(e.key==='ArrowLeft'){go(idx-1,true);e.preventDefault()}
  });

  // autoplay (pauses after user interaction, when off-screen, or reduced motion)
  if(!reduce){
    auto=setInterval(function(){
      if(!vis||down||Date.now()-idle<9000)return;
      go(idx>=N-1?0:idx+1);
    },chat?5200:5200);
  }
  if('IntersectionObserver' in window){new IntersectionObserver(function(es){vis=es[0].isIntersecting}).observe(deck)}

  go(0);
}

// download button
function toast(t){var el=$('#toast');if(!el)return;el.textContent=t;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(function(){el.classList.remove('show')},2800)}
$$('.js-download').forEach(function(b){b.addEventListener('click',function(e){
  var url=(window.WA_DOWNLOAD_URL||'').trim();
  if(!url){e.preventDefault();toast('Download link coming soon — stay tuned!')}
  else{b.setAttribute('href',url)}
})});

// scrollspy (privacy)
var toc=$$('.toc a');
if(toc.length&&'IntersectionObserver' in window){
  var secs=toc.map(function(a){return $(a.getAttribute('href'))}).filter(Boolean);
  var so=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){toc.forEach(function(a){a.classList.toggle('on',a.getAttribute('href')==='#'+e.target.id)})}})},{rootMargin:'-20% 0px -70% 0px'});
  secs.forEach(function(s){so.observe(s)});
}
var y=$('#yr');if(y)y.textContent=new Date().getFullYear();
})();
