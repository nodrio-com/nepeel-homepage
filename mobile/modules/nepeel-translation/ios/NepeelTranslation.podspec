Pod::Spec.new do |s|
  s.name = 'NepeelTranslation'
  s.version = '1.0.0'
  s.summary = 'On-device translation for nepeel.'
  s.homepage = 'https://nepeel.com'
  s.license = { :type => 'Proprietary' }
  s.author = 'nepeel'
  s.source = { :git => 'https://github.com/nepeel-com/homepage.git' }
  s.platform = :ios, '16.4'
  s.static_framework = true
  s.source_files = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.dependency 'GoogleMLKit/Translate', '9.0.0'
end
