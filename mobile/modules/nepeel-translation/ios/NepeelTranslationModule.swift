import ExpoModulesCore
import MLKitCommon
import MLKitTranslate
import NaturalLanguage

public class NepeelTranslationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NepeelTranslation")

    AsyncFunction("translate") { (text: String, targetTag: String, promise: Promise) in
      guard let detected = NLLanguageRecognizer.dominantLanguage(for: text) else {
        promise.resolve(nil)
        return
      }
      let sourceTag = detected.rawValue.components(separatedBy: "-")[0]
      let source = TranslateLanguage(rawValue: sourceTag)
      let target = TranslateLanguage(rawValue: targetTag)
      let supported = TranslateLanguage.allLanguages()
      guard source != target, supported.contains(source), supported.contains(target) else {
        promise.resolve(nil)
        return
      }
      let options = TranslatorOptions(sourceLanguage: source, targetLanguage: target)
      let translator = Translator.translator(options: options)
      let wifi = ModelDownloadConditions(allowsCellularAccess: false, allowsBackgroundDownloading: true)
      translator.downloadModelIfNeeded(with: wifi) { error in
        guard error == nil else {
          promise.resolve(nil)
          return
        }
        translator.translate(text) { result, error in
          promise.resolve(error == nil ? result : nil)
        }
      }
    }
  }
}
