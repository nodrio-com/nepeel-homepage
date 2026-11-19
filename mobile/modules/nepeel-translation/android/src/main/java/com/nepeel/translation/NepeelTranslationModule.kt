package com.nepeel.translation

import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.nl.languageid.LanguageIdentification
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.TranslatorOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NepeelTranslationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NepeelTranslation")

    AsyncFunction("translate") { text: String, targetTag: String, promise: Promise ->
      val target = TranslateLanguage.fromLanguageTag(targetTag)
      if (target == null) {
        promise.resolve(null)
        return@AsyncFunction
      }
      val identifier = LanguageIdentification.getClient()
      identifier.identifyLanguage(text).addOnCompleteListener { detection ->
        identifier.close()
        val source = if (detection.isSuccessful) {
          TranslateLanguage.fromLanguageTag(detection.result)
        } else null
        if (source == null || source == target) {
          promise.resolve(null)
          return@addOnCompleteListener
        }
        val options = TranslatorOptions.Builder().setSourceLanguage(source).setTargetLanguage(target).build()
        val translator = Translation.getClient(options)
        val wifi = DownloadConditions.Builder().requireWifi().build()
        translator.downloadModelIfNeeded(wifi)
          .onSuccessTask { translator.translate(text) }
          .addOnCompleteListener { translation ->
            translator.close()
            promise.resolve(if (translation.isSuccessful) translation.result else null)
          }
      }
    }
  }
}
