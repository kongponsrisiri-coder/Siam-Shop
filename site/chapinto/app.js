(function(){
  var b=document.querySelector('.burger'),m=document.querySelector('.mnav');
  if(b&&m){b.addEventListener('click',function(){m.classList.add('open');document.body.style.overflow='hidden';});
    m.querySelectorAll('a,.x').forEach(function(a){a.addEventListener('click',function(){m.classList.remove('open');document.body.style.overflow='';});});}
  if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.1});
    document.querySelectorAll('.reveal').forEach(function(el){io.observe(el);});}else{document.querySelectorAll('.reveal').forEach(function(el){el.classList.add('in');});}
  var cats=[].slice.call(document.querySelectorAll('.cats a[data-cat]')),prods=[].slice.call(document.querySelectorAll('.prod'));
  cats.forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();cats.forEach(function(x){x.classList.remove('on');});a.classList.add('on');var c=a.dataset.cat;
    prods.forEach(function(p){p.style.display=(c==='all'||p.dataset.cat===c)?'':'none';});});});
})();